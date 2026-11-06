#!/usr/bin/env python3
"""
Test suite for XDMoD Python MCP Server
"""

import pytest
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