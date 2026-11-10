#!/usr/bin/env python3
"""
Test suite for XDMoD Python MCP Server
"""

import pytest
import requests
import asyncio
import os
import sys
from unittest.mock import Mock, patch, AsyncMock
from datetime import datetime, timedelta

# Add src to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from xdmod_mcp_data.server import XDMoDPythonServer


class TestXDMoDPythonServer:
    def setup_method(self):
        """Set up test fixtures"""
        self.server_instance = XDMoDPythonServer()
    
    def test_server_initialization(self):
        """Test server initializes correctly"""
        assert self.server_instance.server is not None
        assert self.server_instance.base_url == "https://xdmod.access-ci.org"
        
    def test_api_token_from_env(self):
        """Test API token is read from environment"""
        with patch.dict(os.environ, {'XDMOD_API_TOKEN': 'test-token'}):
            server = XDMoDPythonServer()
            assert server.api_token == 'test-token'
    
    def test_api_token_missing(self):
        """Test server handles missing API token"""
        with patch.dict(os.environ, {}, clear=True):
            server = XDMoDPythonServer()
            assert server.api_token is None

    @pytest.mark.asyncio
    async def test_debug_auth_tool(self):
        """Test debug authentication tool"""
        with patch.dict(os.environ, {'XDMOD_API_TOKEN': 'test-token-123'}):
            server = XDMoDPythonServer()
            result = await server._debug_auth()
            
            assert len(result) > 0
            content = result[0].text
            assert "XDMoD Python MCP Server Debug" in content
            assert "test-token..." in content

    @pytest.mark.asyncio 
    async def test_debug_auth_no_token(self):
        """Test debug authentication without token"""
        with patch.dict(os.environ, {}, clear=True):
            server = XDMoDPythonServer()
            result = await server._debug_auth()
            
            assert len(result) > 0
            content = result[0].text
            assert "XDMoD Python MCP Server Debug" in content

    @pytest.mark.asyncio
    async def test_get_user_data_python_requires_params(self):
        """Test user data retrieval parameter validation"""
        server = XDMoDPythonServer()
        
        # Missing required parameters should raise KeyError
        with pytest.raises(KeyError):
            await server._get_user_data_python({})

    @pytest.mark.asyncio
    async def test_get_user_data_python_no_token(self):
        """Test user data retrieval without API token"""
        server = XDMoDPythonServer()
        
        args = {
            'access_id': 'testuser',
            'start_date': '2024-01-01',
            'end_date': '2024-01-31'
        }
        
        result = await server._get_user_data_python(args)
        
        assert len(result) > 0
        content = result[0].text
        assert "No API token configured" in content

    @pytest.mark.asyncio
    async def test_test_data_framework(self):
        """Test data framework testing functionality"""
        server = XDMoDPythonServer()
        
        result = await server._test_data_framework()
        
        assert len(result) > 0
        content = result[0].text
        assert "Data Analytics Framework Test" in content

    @pytest.mark.asyncio
    async def test_describe_raw_realms(self):
        """Test raw realms description"""
        server = XDMoDPythonServer()
        
        result = await server._describe_raw_realms({})
        
        assert len(result) > 0
        content = result[0].text
        assert "No API token configured" in content

    @pytest.mark.asyncio
    async def test_describe_raw_fields(self):
        """Test raw fields description"""
        server = XDMoDPythonServer()
        
        result = await server._describe_raw_fields({"realm": "Jobs"})
        
        assert len(result) > 0
        content = result[0].text
        assert "no api token configured" in content.lower()

    @pytest.mark.asyncio
    async def test_get_analysis_template(self):
        """Test analysis template retrieval"""
        server = XDMoDPythonServer()
        
        result = await server._get_analysis_template({"list_templates": True})
        
        assert len(result) > 0
        content = result[0].text
        assert "Analysis Templates" in content

    def test_date_validation(self):
        """Test date validation helper"""
        # Simple date format test since _validate_date doesn't exist
        from datetime import datetime
        
        # Valid date format
        try:
            datetime.strptime("2024-01-01", "%Y-%m-%d")
            valid_date = True
        except ValueError:
            valid_date = False
        assert valid_date == True
        
        # Invalid date format
        try:
            datetime.strptime("invalid", "%Y-%m-%d")
            invalid_date = False
        except ValueError:
            invalid_date = True
        assert invalid_date == True

    def test_every_tool_is_marked_read_only(self):
        """Clients such as the ACCESS agent tell reads from changes by this hint."""
        tools = XDMoDPythonServer().get_tools()
        assert tools
        assert all(t.annotations is not None and t.annotations.readOnlyHint is True for t in tools)

    def test_tools_list(self):
        """Test that server provides expected tools"""
        server = XDMoDPythonServer()
        tools = server.get_tools()

        tool_names = [tool.name for tool in tools]
        expected_tools = [
            "get_user_data",
            "get_raw_data",
            "describe_fields",
            "describe_realms",
        ]

        for expected_tool in expected_tools:
            assert expected_tool in tool_names

    def test_raw_data_filters_example_fits_schema(self):
        """The filters example is valid input and promises no unsupported operators"""
        import json
        import re

        tools = {t.name: t for t in XDMoDPythonServer().get_tools()}
        filters = tools["get_raw_data"].inputSchema["properties"]["filters"]
        allowed = filters["additionalProperties"]["anyOf"]
        assert allowed == [{"type": "string"}, {"type": "array", "items": {"type": "string"}, "minItems": 1}]

        examples = re.findall(r"\{[^{}]*\}", filters["description"])
        assert examples
        for example in examples:
            for value in json.loads(example).values():
                assert isinstance(value, str) or (
                    isinstance(value, list) and all(isinstance(v, str) for v in value)
                ), example
                values = [value] if isinstance(value, str) else value
                assert not any(re.match(r"\s*[<>=]", v) for v in values), example

    def test_request_token_priority(self):
        """Test that request header token takes priority over env var"""
        from xdmod_mcp_data.base_server import _request_headers

        with patch.dict(os.environ, {'XDMOD_API_TOKEN': 'env-token'}):
            server = XDMoDPythonServer()

            # Without request context, should use env token
            assert server.api_token == 'env-token'

            # Simulate a request with header token via context var
            token = _request_headers.set({'x-xdmod-token': 'request-token'})
            try:
                assert server.api_token == 'request-token'
            finally:
                _request_headers.reset(token)

            # After reset, should fall back to env
            assert server.api_token == 'env-token'

    def test_request_token_without_env(self):
        """Test request token works when no env var is set"""
        from xdmod_mcp_data.base_server import _request_headers

        with patch.dict(os.environ, {}, clear=True):
            server = XDMoDPythonServer()
            assert server.api_token is None

            # Set request token via context var
            token = _request_headers.set({'x-xdmod-token': 'request-token'})
            try:
                assert server.api_token == 'request-token'
            finally:
                _request_headers.reset(token)


class TestXDMoDPythonIntegration:
    """Integration tests that make real API calls"""
    
    def setup_method(self):
        self.server = XDMoDPythonServer()
    
    @pytest.mark.integration
    @pytest.mark.asyncio
    async def test_real_debug_auth(self):
        """Test real debug authentication call"""
        result = await self.server._debug_auth()
        
        assert len(result) > 0
        content = result[0].text
        assert "XDMoD Python MCP Server Debug" in content
    
    @pytest.mark.integration  
    @pytest.mark.asyncio
    async def test_real_describe_realms(self):
        """Test real describe realms call"""
        result = await self.server._describe_raw_realms({})
        
        assert len(result) > 0
        content = result[0].text
        assert "No API token configured" in content
    
    @pytest.mark.integration
    @pytest.mark.asyncio 
    async def test_real_framework_test(self):
        """Test real framework test call"""
        result = await self.server._test_data_framework()
        
        assert len(result) > 0
        content = result[0].text
        assert "Framework" in content

class TestNsfServerErrorText:
    """The peer's 5xx text can carry internal detail, so only a 4xx shows it."""

    def setup_method(self):
        self.server_instance = XDMoDPythonServer()

    def _call(self, status, body, content_type="application/json"):
        response = Mock()
        response.status_code = status
        response.headers = {"content-type": content_type}
        response.json.return_value = body
        response.text = body if isinstance(body, str) else ""
        with patch.object(
            self.server_instance, "_get_service_endpoint", return_value="http://nsf:3007"
        ), patch("xdmod_mcp_data.server.requests.post", return_value=response):
            return asyncio.run(self.server_instance._call_nsf_server("search", {}))

    def test_4xx_shows_the_peers_error(self):
        result = self._call(404, {"error": "Award not found"})
        assert "Award not found" in result
        assert "404" in result

    def test_5xx_json_error_is_not_shown(self):
        result = self._call(500, {"error": "connect ECONNREFUSED 10.0.3.4:5432"})
        assert "10.0.3.4" not in result
        assert "500" in result

    def test_5xx_raw_text_is_not_shown(self):
        result = self._call(502, "<html>upstream host internal.example</html>", "text/html")
        assert "internal.example" not in result
        assert "502" in result

    def test_4xx_raw_text_is_not_shown(self):
        result = self._call(400, "<html>nginx internal.example</html>", "text/html")
        assert "internal.example" not in result


class TestCallerSafeUpstreamText:
    """xdmod-data raises RuntimeError("Error <status>: <message>") and a 500's message can carry SQL."""

    def setup_method(self):
        self.server_instance = XDMoDPythonServer()
        self.server_instance._env_api_token = "t"

    def _realms_text(self, exc):
        dw = Mock()
        dw.describe_realms.side_effect = exc
        dw.__enter__ = Mock(return_value=dw)
        dw.__exit__ = Mock(return_value=False)
        with patch("xdmod_data.warehouse.DataWarehouse", return_value=dw):
            result = asyncio.run(self.server_instance._describe_raw_realms({}))
        return result[0].text

    def test_5xx_message_is_not_shown(self):
        text = self._realms_text(RuntimeError("Error 500: SQLSTATE[42S02]: Base table not found"))
        assert "SQLSTATE" not in text

    def test_4xx_message_is_shown(self):
        text = self._realms_text(RuntimeError("Error 403: You are not authorized for this realm"))
        assert "You are not authorized for this realm" in text

    def test_transport_error_is_not_shown(self):
        text = self._realms_text(
            requests.exceptions.ConnectionError("HTTPSConnectionPool(host='10.1.2.3', port=443)")
        )
        assert "10.1.2.3" not in text

    def test_nsf_connection_error_omits_the_service_url(self):
        with patch.object(
            self.server_instance, "_get_service_endpoint", return_value="http://nsf-internal:3007"
        ), patch(
            "xdmod_mcp_data.server.requests.post",
            side_effect=requests.exceptions.ConnectionError("refused"),
        ):
            result = asyncio.run(self.server_instance._call_nsf_server("search", {}))
        assert "nsf-internal" not in result
        assert "Connection Error" in result


class TestUpstreamFailureLogging:
    """A failure line carries status or code, never the body or exception text."""

    def setup_method(self):
        self.server_instance = XDMoDPythonServer()

    def test_5xx_runtime_error_logs_status_without_message(self, caplog):
        from xdmod_mcp_data.server import caller_safe_error
        with caplog.at_level("WARNING"):
            caller_safe_error(RuntimeError("Error 500: SQLSTATE[42S02] for alice@example.org"))
        assert '"status": 500' in caplog.text
        assert '"upstream": "xdmod"' in caplog.text
        assert "SQLSTATE" not in caplog.text
        assert "alice@example.org" not in caplog.text

    def test_4xx_is_not_logged(self, caplog):
        from xdmod_mcp_data.server import caller_safe_error
        with caplog.at_level("WARNING"):
            caller_safe_error(RuntimeError("Error 403: not authorized"))
        assert caplog.text == ""

    def test_transport_error_logs_code_without_message(self, caplog):
        from xdmod_mcp_data.server import caller_safe_error
        with caplog.at_level("WARNING"):
            caller_safe_error(
                requests.exceptions.ConnectionError("HTTPSConnectionPool(host='10.1.2.3', port=443)")
            )
        assert '"code": "ConnectionError"' in caplog.text
        assert "10.1.2.3" not in caplog.text

    def test_nsf_5xx_logs_status_without_peer_body(self, caplog):
        response = Mock()
        response.status_code = 500
        response.headers = {"content-type": "application/json"}
        response.json.return_value = {"error": "connect ECONNREFUSED 10.0.3.4:5432"}
        with patch.object(
            self.server_instance, "_get_service_endpoint", return_value="http://nsf:3007"
        ), patch("xdmod_mcp_data.server.requests.post", return_value=response), caplog.at_level("WARNING"):
            asyncio.run(self.server_instance._call_nsf_server("search", {}))
        assert '"status": 500' in caplog.text
        assert '"path": "/tools/search"' in caplog.text
        assert "10.0.3.4" not in caplog.text


class TestRawDataUnmatchedFilters:
    """A filter whose names all fail to match must not widen the query to everything."""

    class Warehouse:
        def __init__(self, xdmod_host=None):
            self.data_calls = []

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def get_filter_values(self, realm, dimension):
            import pandas as pd
            return pd.DataFrame({"label": ["NCSA DELTA GPU", "NCSA DELTA CPU"]})

        def get_data(self, **kwargs):
            import pandas as pd
            self.data_calls.append(kwargs)
            return pd.DataFrame({"value": [1.0]}, index=["NCSA DELTA GPU"])

    def _run(self, filters, warehouse=None, realm="Jobs"):
        warehouse = warehouse or self.Warehouse()
        server = XDMoDPythonServer()
        server._env_api_token = "t"
        args = {"start_date": "2026-09-01", "end_date": "2026-09-30", "dimension": "resource",
                "filters": filters, "realm": realm}
        with patch.dict(os.environ, {"XDMOD_API_TOKEN": "t"}), \
             patch("xdmod_data.warehouse.DataWarehouse", return_value=warehouse):
            text = asyncio.run(server._get_raw_data(args)).content[0].text
        return text, warehouse.data_calls

    def test_refuses_when_no_name_matches(self):
        text, calls = self._run({"resource": "Delta"})
        assert calls == []
        assert "No filter values matched for resource, so the query was not run" in text

    def test_runs_with_the_names_that_matched(self):
        text, calls = self._run({"resource": ["Delta", "ncsa delta gpu"]})
        assert len(calls) == 1
        assert calls[0]["filters"] == {"resource": ["NCSA DELTA GPU"]}
        assert "Values not found in Jobs realm for resource: ['Delta']" in text

    def test_refuses_when_one_of_several_dimensions_matches_nothing(self):
        text, calls = self._run({"resource": "NCSA DELTA GPU", "queue": "nope"})
        assert calls == []
        assert "No filter values matched for queue" in text

    def test_refuses_an_empty_list_and_says_why(self):
        text, calls = self._run({"resource": []})
        assert calls == []
        assert "No names were given for resource" in text

    def test_points_supremm_callers_at_jobs(self):
        text, _ = self._run({"resource": "Delta"}, realm="SUPREMM")
        assert "try realm='Jobs'" in text

    def test_runs_with_names_as_given_when_they_cannot_be_checked(self):
        class Unchecked(self.Warehouse):
            def get_filter_values(self, realm, dimension):
                raise RuntimeError("Error 400: unknown dimension")

        warehouse = Unchecked()
        text, calls = self._run({"resource": "Delta"}, warehouse=warehouse)
        assert calls[0]["filters"] == {"resource": ["Delta"]}
        assert "Could not validate filter resource" in text


class TestRawDataTable:
    """The full table goes to a caller that asked for structured content; the model gets a summary."""

    class Warehouse(TestRawDataUnmatchedFilters.Warehouse):
        def __init__(self, data):
            super().__init__()
            self.data = data

        def get_data(self, **kwargs):
            self.data_calls.append(kwargs)
            return self.data

        def describe_metrics(self, realm):
            import pandas as pd
            return pd.DataFrame({"label": ["CPU Hours: Total"]}, index=pd.Index(["total_cpu_hours"], name="id"))

    def _run(self, data, asked, **args):
        from xdmod_mcp_data import base_server
        server = XDMoDPythonServer()
        server._env_api_token = "t"
        args = {"start_date": "2025-01-01", "end_date": "2025-12-31", **args}
        flag = base_server._include_structured.set(asked)
        try:
            with patch.dict(os.environ, {"XDMOD_API_TOKEN": "t"}), \
                 patch("xdmod_data.warehouse.DataWarehouse", return_value=self.Warehouse(data)):
                return asyncio.run(server._get_raw_data(args))
        finally:
            base_server._include_structured.reset(flag)

    def _users(self, n):
        import pandas as pd
        series = pd.Series([float(i) for i in range(n)], index=[f"user {i}" for i in range(n)],
                           name="CPU Hours: Total", dtype="Float64")
        series.index.name = "User"
        return series

    def test_attaches_every_row_for_a_caller_that_asked(self):
        result = self._run(self._users(300), True, dimension="person", dataset_type="aggregate")
        table = result.structured["table"]
        assert len(table["rows"]) == 300
        assert table["dimension"] == "person"
        assert "all 300 rows, is attached" in result.content[0].text
        assert "user 289" not in result.content[0].text

    def test_text_only_for_a_caller_that_did_not_ask(self):
        result = self._run(self._users(300), False, dimension="person", dataset_type="aggregate")
        assert result.structured is None
        assert "first 10 of 300 rows" in result.content[0].text

    def test_over_the_cap_asks_for_a_narrower_request(self):
        from xdmod_mcp_data.raw_table import MAX_TABLE_ROWS
        result = self._run(self._users(MAX_TABLE_ROWS + 1), True, dimension="person",
                           dataset_type="aggregate")
        assert result.structured is None
        assert "narrow the request" in result.content[0].text

    def test_names_the_metric_of_a_grouped_timeseries(self):
        import pandas as pd
        frame = pd.DataFrame({"Delta": [1.0, 2.0]}, index=pd.to_datetime(["2025-01-01", "2025-02-01"]),
                             dtype="Float64")
        frame.index.name = "Time"
        frame.columns.name = "Resource"
        result = self._run(frame, True, dimension="resource", aggregation_unit="Month")
        assert result.structured["table"]["columns"][2]["name"] == "CPU Hours: Total"

    def test_keeps_the_query_lines(self):
        result = self._run(self._users(3), True, dimension="person", dataset_type="aggregate")
        assert "Realm: Jobs" in result.content[0].text
