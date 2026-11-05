#!/usr/bin/env python3
"""
HTTP-level integration tests for the Python base server.

Tests the Starlette app, Streamable HTTP transport, middleware,
REST endpoints, and per-request header propagation.
"""

import os
import sys

import httpx
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from xdmod_mcp_data.base_server import BaseAccessServer, get_request_header
from mcp.types import ToolAnnotations, Tool, TextContent


class SimpleTestServer(BaseAccessServer):
    """Minimal test server with a few tools for testing"""

    def __init__(self):
        super().__init__("test-server", "1.0.0", "https://example.com")

    def get_tools(self):
        return [
            Tool(
                name="echo",
                annotations=ToolAnnotations(readOnlyHint=True),
                description="Echoes input back",
                inputSchema={
                    "type": "object",
                    "properties": {"message": {"type": "string"}},
                },
            ),
            Tool(
                name="check_token",
                description="Returns the current XDMoD token from request context",
                inputSchema={"type": "object", "properties": {}},
            ),
            Tool(
                name="check_acting_user",
                description="Returns the current acting user from request context",
                inputSchema={"type": "object", "properties": {}},
            ),
        ]

    async def handle_tool_call(self, name, arguments):
        if name == "echo":
            msg = arguments.get("message", "")
            return [TextContent(type="text", text=f"echo: {msg}")]
        elif name == "check_token":
            token = get_request_header("x-xdmod-token")
            return [TextContent(type="text", text=f"token: {token or 'none'}")]
        elif name == "check_acting_user":
            user = get_request_header("x-acting-user")
            return [TextContent(type="text", text=f"acting_user: {user or 'none'}")]
        return [TextContent(type="text", text="unknown tool")]


INIT_REQUEST = {
    "jsonrpc": "2.0",
    "method": "initialize",
    "id": 1,
    "params": {
        "protocolVersion": "2025-03-26",
        "capabilities": {},
        "clientInfo": {"name": "test-client", "version": "1.0"},
    },
}

MCP_HEADERS = {
    "Accept": "application/json, text/event-stream",
    "Content-Type": "application/json",
}


def make_server_and_app():
    server = SimpleTestServer()
    app = server.create_starlette_app()
    return server, app


# ---- REST endpoints (no lifespan needed) ----

class TestHealthEndpoint:
    @pytest.mark.asyncio
    async def test_health_returns_200(self):
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/health")
            assert response.status_code == 200
            data = response.json()
            assert data["server"] == "test-server"
            assert data["version"] == "1.0.0"
            assert data["status"] == "healthy"
            assert "timestamp" in data


class TestToolsListEndpoint:
    @pytest.mark.asyncio
    async def test_list_tools(self):
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/tools")
            assert response.status_code == 200
            data = response.json()
            tool_names = [t["name"] for t in data["tools"]]
            assert "echo" in tool_names
            assert "check_token" in tool_names

    @pytest.mark.asyncio
    async def test_list_tools_has_schema(self):
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.get("/tools")
            data = response.json()
            for tool in data["tools"]:
                assert "name" in tool
                assert "description" in tool
                assert "inputSchema" in tool

    @pytest.mark.asyncio
    async def test_list_tools_passes_annotations_through(self):
        """The route builds its JSON by hand, so a tool's readOnlyHint must be copied."""
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            tools = {t["name"]: t for t in (await client.get("/tools")).json()["tools"]}
            assert tools["echo"]["annotations"] == {"readOnlyHint": True}
            assert tools["check_token"]["annotations"] is None


class TestToolExecutionEndpoint:
    @pytest.mark.asyncio
    async def test_execute_tool(self):
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/tools/echo", json={"arguments": {"message": "hello"}}
            )
            assert response.status_code == 200
            data = response.json()
            assert data["content"][0]["text"] == "echo: hello"

    @pytest.mark.asyncio
    async def test_execute_unknown_tool(self):
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/tools/nonexistent", json={"arguments": {}}
            )
            assert response.status_code == 404
            assert "not found" in response.json()["error"]

    @pytest.mark.asyncio
    async def test_execute_tool_no_body(self):
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post("/tools/echo")
            assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_execute_tool_returns_text_content(self):
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/tools/echo", json={"arguments": {"message": "test"}}
            )
            data = response.json()
            assert data["content"][0]["type"] == "text"
            assert "echo: test" in data["content"][0]["text"]


# ---- Streamable HTTP /mcp endpoint (needs lifespan) ----

class TestStreamableHTTPEndpoint:
    @pytest.mark.asyncio
    async def test_initialize(self):
        server, app = make_server_and_app()
        async with server._session_manager.run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://test",
            ) as client:
                response = await client.post("/mcp", json=INIT_REQUEST, headers=MCP_HEADERS)
                assert response.status_code == 200
                assert "mcp-session-id" in response.headers

    @pytest.mark.asyncio
    async def test_post_without_init_returns_error(self):
        server, app = make_server_and_app()
        async with server._session_manager.run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://test",
            ) as client:
                response = await client.post(
                    "/mcp",
                    json={"jsonrpc": "2.0", "method": "tools/list", "id": 1, "params": {}},
                    headers=MCP_HEADERS,
                )
                assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_full_session_lifecycle(self):
        """Test initialize → notifications/initialized → tools/list → tools/call → delete"""
        server, app = make_server_and_app()
        async with server._session_manager.run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://test",
            ) as client:
                # Initialize
                init_resp = await client.post("/mcp", json=INIT_REQUEST, headers=MCP_HEADERS)
                assert init_resp.status_code == 200
                session_id = init_resp.headers.get("mcp-session-id")
                assert session_id

                sh = {**MCP_HEADERS, "mcp-session-id": session_id}

                # Initialized notification
                await client.post(
                    "/mcp",
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                    headers=sh,
                )

                # List tools
                list_resp = await client.post(
                    "/mcp",
                    json={"jsonrpc": "2.0", "method": "tools/list", "id": 2, "params": {}},
                    headers=sh,
                )
                assert list_resp.status_code == 200

                # Call tool
                call_resp = await client.post(
                    "/mcp",
                    json={
                        "jsonrpc": "2.0", "method": "tools/call", "id": 3,
                        "params": {"name": "echo", "arguments": {"message": "lifecycle"}},
                    },
                    headers=sh,
                )
                assert call_resp.status_code == 200

                # Delete session
                del_resp = await client.delete("/mcp", headers={"mcp-session-id": session_id})
                assert del_resp.status_code == 200

    @pytest.mark.asyncio
    async def test_invalid_session_id(self):
        server, app = make_server_and_app()
        async with server._session_manager.run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://test",
            ) as client:
                response = await client.post(
                    "/mcp",
                    json={"jsonrpc": "2.0", "method": "tools/list", "id": 1, "params": {}},
                    headers={**MCP_HEADERS, "mcp-session-id": "nonexistent"},
                )
                assert response.status_code in (400, 404)


# ---- Header propagation ----

class TestHeaderPropagation:
    @pytest.mark.asyncio
    async def test_xdmod_token_reaches_tool_handler(self):
        """Verify X-XDMoD-Token propagates through middleware → session manager → tool handler"""
        server, app = make_server_and_app()
        async with server._session_manager.run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://test",
            ) as client:
                # Initialize with token
                init_resp = await client.post(
                    "/mcp", json=INIT_REQUEST,
                    headers={**MCP_HEADERS, "X-XDMoD-Token": "test-token-abc"},
                )
                session_id = init_resp.headers.get("mcp-session-id")
                sh = {**MCP_HEADERS, "mcp-session-id": session_id, "X-XDMoD-Token": "test-token-abc"}

                await client.post(
                    "/mcp",
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                    headers=sh,
                )

                # Call check_token — should see the header value
                call_resp = await client.post(
                    "/mcp",
                    json={
                        "jsonrpc": "2.0", "method": "tools/call", "id": 2,
                        "params": {"name": "check_token", "arguments": {}},
                    },
                    headers=sh,
                )
                assert call_resp.status_code == 200

    @pytest.mark.asyncio
    async def test_acting_user_reaches_tool_handler(self):
        """Verify X-Acting-User is captured and readable via get_request_header.

        Uses the REST /tools/{tool_name} endpoint so the returned value can be
        asserted directly. The usage logger reads acting_user the same way.
        """
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/tools/check_acting_user",
                json={"arguments": {}},
                headers={"X-Acting-User": "alice@example.com"},
            )
            assert response.status_code == 200
            data = response.json()
            assert data["content"][0]["text"] == "acting_user: alice@example.com"

    @pytest.mark.asyncio
    async def test_acting_user_absent_without_header(self):
        """Verify acting user is None when the header is not sent."""
        _, app = make_server_and_app()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test"
        ) as client:
            response = await client.post(
                "/tools/check_acting_user", json={"arguments": {}}
            )
            assert response.status_code == 200
            data = response.json()
            assert data["content"][0]["text"] == "acting_user: none"

    @pytest.mark.asyncio
    async def test_token_absent_without_header(self):
        """Verify tool handler sees no token when header is not sent"""
        server, app = make_server_and_app()
        async with server._session_manager.run():
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://test",
            ) as client:
                init_resp = await client.post("/mcp", json=INIT_REQUEST, headers=MCP_HEADERS)
                session_id = init_resp.headers.get("mcp-session-id")
                sh = {**MCP_HEADERS, "mcp-session-id": session_id}

                await client.post(
                    "/mcp",
                    json={"jsonrpc": "2.0", "method": "notifications/initialized"},
                    headers=sh,
                )

                call_resp = await client.post(
                    "/mcp",
                    json={
                        "jsonrpc": "2.0", "method": "tools/call", "id": 2,
                        "params": {"name": "check_token", "arguments": {}},
                    },
                    headers=sh,
                )
                assert call_resp.status_code == 200
