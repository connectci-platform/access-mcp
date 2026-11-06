#!/usr/bin/env python3
"""
Python Base ACCESS Server

Provides Streamable HTTP and stdio support for MCP servers,
equivalent to the TypeScript BaseAccessServer functionality.
"""

import asyncio
import contextlib
import contextvars
import json
import os
import time
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any, Dict, List, Optional

import uvicorn
from mcp.server.lowlevel import Server
from mcp.server.sse import SseServerTransport
from mcp.server.stdio import stdio_server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.types import Tool, TextContent
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

# Context variable for per-request headers (accessible from tool handlers)
_request_headers: contextvars.ContextVar[Dict[str, str]] = contextvars.ContextVar(
    "request_headers", default={}
)


def get_request_header(name: str) -> Optional[str]:
    """Get a header value from the current request context"""
    return _request_headers.get({}).get(name)


class HeaderCaptureMiddleware(BaseHTTPMiddleware):
    """Middleware that captures select request headers into context variables"""

    CAPTURED_HEADERS = ("x-xdmod-token", "x-acting-user")

    async def dispatch(self, request: Request, call_next):
        headers = {}
        for name in self.CAPTURED_HEADERS:
            value = request.headers.get(name)
            if value:
                headers[name] = value
        token = _request_headers.set(headers)
        try:
            return await call_next(request)
        finally:
            _request_headers.reset(token)


class BaseAccessServer(ABC):
    """Base class for ACCESS-CI MCP servers with Streamable HTTP and stdio support"""

    def __init__(self, server_name: str, version: str, base_url: Optional[str] = None):
        self.server_name = server_name
        self.version = version
        self.base_url = base_url or "https://access-ci.org"
        self.server = Server(server_name)
        self._session_manager: Optional[StreamableHTTPSessionManager] = None
        from .usage_logger import UsageLogger
        self._usage_logger = UsageLogger(os.environ.get("MCP_USAGE_DB_URL"))
        self._usage_tasks: set = set()
        self._setup_handlers()

    @abstractmethod
    def get_tools(self) -> List[Tool]:
        """Return list of available tools"""
        pass

    @abstractmethod
    async def handle_tool_call(self, name: str, arguments: Dict[str, Any]) -> Any:
        """Handle tool execution"""
        pass

    async def _record_and_handle(self, name: str, arguments: Dict[str, Any]) -> Any:
        """The single logging seam for tool calls. EVERY doorway (REST /tools,
        the MCP-protocol call_tool handler, the SSE call_tool handler) must call
        this instead of handle_tool_call directly, so usage logging covers all
        paths with no duplication. Timing + fire-and-forget record (GC-safe task
        retention); the record never delays or raises into the caller.
        If you add a new tool-invocation path, route it through here.
        """
        started = time.monotonic()
        succeeded = False
        try:
            result = await self.handle_tool_call(name, arguments)
            succeeded = True
            return result
        finally:
            _usage_task = asyncio.ensure_future(
                self._usage_logger.record(
                    server=self.server_name,
                    tool=name,
                    arguments=arguments,
                    success=succeeded,
                    duration_ms=(time.monotonic() - started) * 1000,
                    acting_user=get_request_header("x-acting-user"),
                )
            )
            # Retain a strong reference so the fire-and-forget task isn't
            # garbage-collected mid-flight (CPython only weakly refs pending tasks).
            self._usage_tasks.add(_usage_task)
            _usage_task.add_done_callback(self._usage_tasks.discard)

    def _setup_handlers(self):
        """Setup MCP tool handlers"""
        tools = self.get_tools()

        @self.server.list_tools()
        async def list_tools():
            return tools

        @self.server.call_tool()
        async def handle_call(name: str, arguments: Dict[str, Any]):
            return await self._record_and_handle(name, arguments)

    async def start(self, http_port: Optional[int] = None):
        """Start the server in HTTP or stdio mode"""
        port = http_port or (
            int(os.environ["PORT"]) if os.environ.get("PORT") else None
        )

        if port:
            await self._start_http_server(port)
        else:
            await self._start_stdio_server()

    async def _start_stdio_server(self):
        """Start in stdio mode for MCP communication"""
        async with stdio_server() as (read_stream, write_stream):
            await self.server.run(
                read_stream,
                write_stream,
                self.server.create_initialization_options(),
            )

    def create_starlette_app(self) -> Starlette:
        """Create the Starlette ASGI application with all routes and middleware.

        This is separated from _start_http_server so tests can access the app
        via httpx.ASGITransport without starting a real server.
        """
        self._session_manager = StreamableHTTPSessionManager(
            app=self.server,
        )

        # Health check endpoint
        async def health(request: Request) -> JSONResponse:
            return JSONResponse(
                {
                    "server": self.server_name,
                    "version": self.version,
                    "status": "healthy",
                    "timestamp": datetime.utcnow().isoformat() + "Z",
                }
            )

        # Wrapped in a class so Starlette's Route treats it as ASGI, not request-response.
        session_manager = self._session_manager

        class McpAsgiApp:
            async def __call__(self, scope, receive, send):
                await session_manager.handle_request(scope, receive, send)

        mcp_asgi_app = McpAsgiApp()

        # List tools endpoint (REST API for inter-server communication)
        async def list_tools(request: Request) -> JSONResponse:
            tools = self.get_tools()
            tools_data = [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "inputSchema": tool.inputSchema,
                    # This route builds the JSON by hand, so annotations
                    # (readOnlyHint) must be copied or REST clients lose them.
                    "annotations": (
                        tool.annotations.model_dump(exclude_none=True) if tool.annotations else None
                    ),
                }
                for tool in tools
            ]
            return JSONResponse({"tools": tools_data})

        # Tool execution endpoint (REST API for inter-server communication)
        async def execute_tool(request: Request) -> JSONResponse:
            tool_name = request.path_params["tool_name"]

            try:
                body = await request.json()
                arguments = body.get("arguments", {})
            except Exception:
                arguments = {}

            tools = self.get_tools()
            tool_exists = any(t.name == tool_name for t in tools)
            if not tool_exists:
                return JSONResponse(
                    {"error": f"Tool '{tool_name}' not found"}, status_code=404
                )

            try:
                result = await self._record_and_handle(tool_name, arguments)

                # Format result for REST API
                if isinstance(result, list) and result and hasattr(result[0], "text"):
                    content = [
                        {"type": item.type, "text": item.text} for item in result
                    ]
                elif isinstance(result, str):
                    content = [{"type": "text", "text": result}]
                else:
                    content = [{"type": "text", "text": json.dumps(result, indent=2)}]

                return JSONResponse({"content": content})

            except Exception as e:
                return JSONResponse({"error": str(e)}, status_code=500)

        # Legacy SSE transport for clients that don't support Streamable HTTP.
        # Note: Per-request header propagation (e.g., X-XDMoD-Token) does NOT work
        # over SSE — headers arrive on separate GET/POST requests. Use Streamable HTTP
        # or the REST /tools/:toolName endpoint for token-authenticated access.
        path_prefix = os.environ.get("MCP_PATH_PREFIX", "")
        sse_transport = SseServerTransport(f"{path_prefix}/messages")

        async def sse_handler(request: Request):
            async with sse_transport.connect_sse(
                request.scope, request.receive, request._send
            ) as streams:
                sse_server = Server(self.server_name)
                tools = self.get_tools()

                @sse_server.list_tools()
                async def _list_tools():
                    return tools

                @sse_server.call_tool()
                async def _handle_call(name: str, arguments: Dict[str, Any]):
                    return await self._record_and_handle(name, arguments)

                await sse_server.run(
                    streams[0],
                    streams[1],
                    sse_server.create_initialization_options(),
                )
            return Response()

        async def sse_messages_handler(request: Request):
            await sse_transport.handle_post_message(
                request.scope, request.receive, request._send
            )

        @contextlib.asynccontextmanager
        async def lifespan(app: Starlette) -> AsyncIterator[None]:
            async with self._session_manager.run():
                yield

        return Starlette(
            debug=False,
            lifespan=lifespan,
            routes=[
                Route("/health", health, methods=["GET"]),
                Route("/mcp", endpoint=mcp_asgi_app, methods=["GET", "POST", "DELETE"]),
                Route("/sse", sse_handler, methods=["GET"]),
                Route("/messages", sse_messages_handler, methods=["POST"]),
                Route("/tools", list_tools, methods=["GET"]),
                Route("/tools/{tool_name}", execute_tool, methods=["POST"]),
            ],
            middleware=[
                Middleware(HeaderCaptureMiddleware),
            ],
        )

    async def _start_http_server(self, port: int):
        """Start HTTP server with Streamable HTTP transport for Docker deployment"""
        starlette_app = self.create_starlette_app()

        print(f"{self.server_name} HTTP server running on port {port}")

        config = uvicorn.Config(
            starlette_app,
            host="0.0.0.0",
            port=port,
            log_level="info",
        )
        server = uvicorn.Server(config)
        await server.serve()
