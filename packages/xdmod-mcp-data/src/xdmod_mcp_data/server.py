#!/usr/bin/env python3
"""
XDMoD Python MCP Server

Uses the XDMoD data analytics framework for better user-specific data access.
"""

import asyncio
import json
import os
import sys
import time
from typing import Any, Callable, Dict, List, Optional
from datetime import timedelta

import pandas as pd
import requests
from dotenv import load_dotenv
from mcp.types import TextContent, Tool
from .base_server import BaseAccessServer

# xdmod-data sends its requests with no timeout and offers no way to set one,
# so this deadline is what bounds how long a tool call waits on XDMoD. The
# worker thread itself can't be cancelled and is left to finish on its own.
XDMOD_CALL_TIMEOUT_SECONDS = float(os.getenv("XDMOD_CALL_TIMEOUT_SECONDS", "60"))


class XDMoDUnavailableError(Exception):
    pass


class XDMoDPythonServer(BaseAccessServer):
    def __init__(self):
        super().__init__("xdmod-mcp-data", "0.4.0", "https://xdmod.access-ci.org")
        self._env_api_token = os.getenv("XDMOD_API_TOKEN")

    @property
    def api_token(self) -> str | None:
        """Get the effective API token: per-request header takes priority over env var"""
        from .base_server import get_request_header
        request_token = get_request_header("x-xdmod-token")
        if request_token:
            return request_token
        return self._env_api_token

    async def _xdmod_call(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        """Run a blocking xdmod-data call in a worker thread so a stalled XDMoD
        can't freeze the event loop for every other session."""
        try:
            return await asyncio.wait_for(
                asyncio.to_thread(fn, *args, **kwargs), XDMOD_CALL_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError:
            raise XDMoDUnavailableError(
                f"XDMoD at {self.base_url} did not respond within "
                f"{XDMOD_CALL_TIMEOUT_SECONDS:g}s; it may be down or unreachable."
            ) from None

    def get_tools(self) -> List[Tool]:
        """Return list of available tools"""
        return [
                Tool(
                    name="get_user_data",
                    description="Get user-specific usage data by exact user identifier. Use the COMPLETE user name exactly as provided.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "access_id": {
                                "type": "string", 
                                "description": "REQUIRED: Complete user identifier exactly as found (e.g., 'Smith, John - State University'). DO NOT truncate or modify - use the full string exactly.",
                            },
                            "start_date": {
                                "type": "string",
                                "description": "Start date (YYYY-MM-DD)",
                            },
                            "end_date": {
                                "type": "string", 
                                "description": "End date (YYYY-MM-DD)",
                            },
                            "realm": {
                                "type": "string",
                                "description": "XDMoD realm (default: Jobs)",
                                "default": "Jobs",
                            },
                            "statistic": {
                                "type": "string",
                                "description": "Statistic to retrieve (default: total_cpu_hours)",
                                "default": "total_cpu_hours",
                            },
                        },
                        "required": ["access_id", "start_date", "end_date"],
                    },
                ),
                Tool(
                    name="get_raw_data",
                    description="Extract actual XDMoD metrics data with filtering. This is the PRIMARY data extraction tool. Use filters parameter with values discovered via get_smart_filters() or use configuration from get_analysis_template(). Supports complex boolean filters, timeseries/aggregate modes, and progress tracking for large datasets.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "realm": {
                                "type": "string",
                                "description": "XDMoD realm: Jobs, SUPREMM, Cloud, Storage, ResourceSpecifications",
                                "default": "Jobs",
                            },
                            "dimension": {
                                "type": "string",
                                "description": "Dimension for grouping data (e.g., person, resource, institution, pi, none)",
                            },
                            "metric": {
                                "type": "string",
                                "description": "Metric to retrieve (e.g., total_cpu_hours, job_count, wall_hours)",
                                "default": "total_cpu_hours",
                            },
                            "start_date": {
                                "type": "string",
                                "description": "Start date (YYYY-MM-DD)",
                            },
                            "end_date": {
                                "type": "string",
                                "description": "End date (YYYY-MM-DD)",
                            },
                            "filters": {
                                "type": "object",
                                "description": "Complex filter combinations. Use get_smart_filters() first to discover valid filter values. Example: {'resource': ['Delta', 'Bridges-2'], 'pi': 'Smith', 'jobsize': '>1000'}. Supports boolean operators (AND/OR) and comparison operators (>, <, =).",
                            },
                            "aggregation_unit": {
                                "type": "string",
                                "description": "Time aggregation: 'Auto', 'Day', 'Month', 'Quarter', or 'Year' (case-sensitive)",
                                "default": "Auto",
                            },
                            "dataset_type": {
                                "type": "string",
                                "description": "Dataset type: 'timeseries' for raw data over time (default), 'aggregate' for summary totals",
                                "default": "timeseries",
                            },
                            "show_progress": {
                                "type": "boolean",
                                "description": "Show progress updates for large data retrievals",
                                "default": False,
                            },
                        },
                        "required": ["start_date", "end_date"],
                    },
                ),
                Tool(
                    name="describe_fields",
                    description="Discover what dimensions and metrics exist in a specific realm (e.g., Jobs, SUPREMM). Use this to learn what can be queried. For example: 'What dimensions are available in the Jobs realm?' Returns dimension names (resource, person, institution, etc.) and available metrics (total_cpu_hours, job_count, etc.).",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "realm": {
                                "type": "string",
                                "description": "XDMoD realm to describe (e.g., Jobs, SUPREMM, Cloud, Storage)",
                                "default": "Jobs",
                            },
                            "include_metrics": {
                                "type": "boolean",
                                "description": "Include available metrics in the response",
                                "default": True,
                            },
                            "include_filter_values": {
                                "type": "boolean",
                                "description": "Include sample filter values for dimensions",
                                "default": False,
                            },
                        },
                        "required": [],
                    },
                ),
                Tool(
                    name="describe_realms",
                    description="List all available XDMoD data realms (Jobs, SUPREMM, Cloud, Storage, etc.) with their capabilities. Use this when you need to know what data categories exist. For example: 'What realms are available?' or 'Where can I find GPU metrics?' (Answer: SUPREMM realm).",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "include_details": {
                                "type": "boolean",
                                "description": "Include detailed information about each realm",
                                "default": True,
                            },
                        },
                        "required": [],
                    },
                ),
                Tool(
                    name="get_smart_filters",
                    description="Discover what filter values are available for use with get_raw_data(). Use this BEFORE calling get_raw_data() to find valid resources, queues, institutions, etc. Returns categorized lists like 'GPU resources', 'batch queues', 'physical sciences'. Workflow: get_smart_filters() → get_raw_data() with discovered values.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "realm": {
                                "type": "string",
                                "description": "XDMoD realm to query",
                                "default": "Jobs"
                            },
                            "dimension": {
                                "type": "string", 
                                "description": "Dimension to get filters for (resource, queue, person, fieldofscience, institution, etc.)",
                                "default": "resource"
                            },
                            "category": {
                                "type": "string",
                                "description": "Filter category: gpu, cpu, memory, storage, physical, life, engineering, all",
                                "default": "all"
                            },
                            "search_prefix": {
                                "type": "string",
                                "description": "Filter values by prefix for autocomplete-style searching (e.g., 'univ' for universities)",
                                "default": ""
                            },
                            "force_large_dimensions": {
                                "type": "boolean",
                                "description": "Override size limits for large dimensions (>1000 values)",
                                "default": False
                            },
                            "limit": {
                                "type": "integer",
                                "description": "Max items to display per category",
                                "default": 20
                            }
                        },
                        "required": [],
                    },
                ),
                Tool(
                    name="get_analysis_template",
                    description="Get pre-configured analysis patterns for common scenarios (queue analysis, allocation efficiency, performance analysis, etc.). Use this when you want a standardized analysis instead of building a custom query. Returns ready-to-use configuration with pre-defined metrics and semantic filters. Workflow: get_analysis_template() → Use returned config with get_raw_data().",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "analysis_type": {
                                "type": "string",
                                "description": "Type of analysis template. Common templates: queue_analysis, allocation_efficiency, performance_efficiency, multi_node_scaling, service_provider_comparison, grant_type_analysis, field_of_science_trends, institutional_comparison, resource_portfolio, user_cohort_analysis",
                            },
                            "list_templates": {
                                "type": "boolean",
                                "description": "Set to true to list all 14 available analysis templates with descriptions",
                                "default": False,
                            },
                        },
                        "required": [],
                    },
                ),
                Tool(
                    name="integrate_nsf_xdmod",
                    description="Integrate NSF funding data with XDMoD computational usage patterns. Query by researcher, award, or institution to correlate funding with actual usage.",
                    inputSchema={
                        "type": "object",
                        "properties": {
                            "query_type": {
                                "type": "string",
                                "description": "Type of integration query: 'researcher' (researcher-centric usage with NSF funding), 'award' (award-centric funding vs usage comparison), 'institution' (institutional research profile with funding and usage)",
                                "enum": ["researcher", "award", "institution"],
                            },
                            "search_value": {
                                "type": "string",
                                "description": "Search value based on query_type: researcher name, NSF award number, or institution name",
                            },
                            "start_date": {
                                "type": "string",
                                "description": "Start date for analysis in YYYY-MM-DD format",
                            },
                            "end_date": {
                                "type": "string",
                                "description": "End date for analysis in YYYY-MM-DD format",
                            },
                            "limit": {
                                "type": "integer",
                                "description": "Maximum number of NSF awards to include (default: 5 for researcher, 10 for institution)",
                                "default": 5,
                            },
                            "top_researchers": {
                                "type": "integer",
                                "description": "Number of top researchers to highlight (only for query_type='institution', default: 10)",
                                "default": 10,
                            },
                        },
                        "required": ["query_type", "search_value", "start_date", "end_date"],
                    },
                ),
        ]

    async def handle_tool_call(self, name: str, arguments: Dict[str, Any]) -> Any:
        """Handle tool execution"""
        if name == "get_user_data":
            return await self._get_user_data_python(arguments)
        elif name == "get_raw_data":
            return await self._get_raw_data(arguments)
        elif name == "describe_fields":
            return await self._describe_raw_fields(arguments)
        elif name == "describe_realms":
            return await self._describe_raw_realms(arguments)
        elif name == "get_analysis_template":
            return await self._get_analysis_template(arguments)
        elif name == "get_smart_filters":
            return await self._get_smart_filters(arguments)
        elif name == "integrate_nsf_xdmod":
            return await self._integrate_nsf_xdmod_router(arguments)
        else:
            raise ValueError(f"Unknown tool: {name}")

    async def _integrate_nsf_xdmod_router(self, arguments: Dict[str, Any]) -> Any:
        """Router for consolidated NSF+XDMoD integration tool"""
        query_type = arguments.get("query_type")

        if query_type == "researcher":
            # Route to researcher-centric analysis
            return await self._get_usage_with_nsf_context({
                "researcher_name": arguments["search_value"],
                "start_date": arguments["start_date"],
                "end_date": arguments["end_date"],
                "limit": arguments.get("limit", 5),
            })
        elif query_type == "award":
            # Route to award-centric analysis
            return await self._analyze_funding_vs_usage({
                "nsf_award_number": arguments["search_value"],
                "start_date": arguments["start_date"],
                "end_date": arguments["end_date"],
            })
        elif query_type == "institution":
            # Route to institutional profile
            return await self._institutional_research_profile({
                "institution_name": arguments["search_value"],
                "start_date": arguments["start_date"],
                "end_date": arguments["end_date"],
                "top_researchers": arguments.get("top_researchers", 10),
            })
        else:
            raise ValueError(f"Invalid query_type: {query_type}. Must be 'researcher', 'award', or 'institution'")
    
    async def _debug_auth(self) -> List[TextContent]:
        """Debug authentication and environment"""
        
        # Check environment
        token_present = bool(self.api_token)
        token_length = len(self.api_token) if self.api_token else 0
        token_preview = self.api_token[:10] + "..." if self.api_token else "None"
        
        # Check Python packages
        packages = {}
        try:
            import pandas
            packages["pandas"] = pandas.__version__
        except ImportError:
            packages["pandas"] = "Not installed"
            
        try:
            import requests
            packages["requests"] = requests.__version__
        except ImportError:
            packages["requests"] = "Not installed"
            
        # Check XDMoD data analytics framework
        xdmod_framework_status = "Not found"
        try:
            import xdmod_data
            xdmod_framework_status = f"Found: xdmod-data v{getattr(xdmod_data, '__version__', 'unknown')}"
            
            # Check if we can create a client
            if hasattr(xdmod_data, 'Client'):
                xdmod_framework_status += " (Client class available)"
        except ImportError:
            pass
        
        # Dynamic next steps based on actual status
        next_steps = []
        if "Not found" in xdmod_framework_status:
            next_steps.append("Install XDMoD data analytics framework: pip install xdmod-data")
        else:
            next_steps.append("XDMoD framework installed and ready")
            
        if not token_present:
            next_steps.append("Set XDMOD_API_TOKEN environment variable")
        else:
            next_steps.append("API token configured")
            
        next_steps.append("Compare with @access-mcp/xdmod server results")
        
        formatted_steps = '\n'.join(f"{i+1}. {step}" for i, step in enumerate(next_steps))

        result = f"""🐍 **XDMoD Python MCP Server Debug**

**Environment:**
- Python version: {sys.version.split()[0]}
- API Token present: {token_present}
- Token length: {token_length}
- Token preview: {token_preview}

**Dependencies:**
- pandas: {packages['pandas']}
- requests: {packages['requests']}

**XDMoD Data Analytics Framework:**
- Status: {xdmod_framework_status}

**Next Steps:**
{formatted_steps}
"""

        return [TextContent(type="text", text=result)]
    
    async def _smart_find_user(self, search_name: str, realm: str = "Jobs") -> tuple[str, str]:
        """Find the actual user name using smart matching. Returns (matched_name, status_message)"""
        try:
            from xdmod_data.warehouse import DataWarehouse
            import os
            
            os.environ['XDMOD_API_TOKEN'] = self.api_token
            load_dotenv()
            
            dw = DataWarehouse(xdmod_host=self.base_url)
            
            with dw:
                filter_df = await self._xdmod_call(dw.get_filter_values, realm=realm, dimension='person')
                
                # Convert DataFrame to list of strings (same as smart filters)
                valid_users = filter_df['label'].tolist() if 'label' in filter_df.columns else filter_df.iloc[:, 0].tolist()
                
                # Use our existing find_matching_value logic
                def find_matching_value(search_val, valid_list):
                    search_val = str(search_val).strip()
                    
                    # Try exact match first
                    if search_val in valid_list:
                        return search_val
                    
                    # Try case-insensitive match
                    for valid_val in valid_list:
                        if search_val.lower() == str(valid_val).lower().strip():
                            return valid_val
                    
                    # Try fuzzy matching for names (handles whitespace differences)
                    search_normalized = ' '.join(search_val.split())
                    for valid_val in valid_list:
                        valid_normalized = ' '.join(str(valid_val).split())
                        if search_normalized.lower() == valid_normalized.lower():
                            return valid_val
                    
                    # Try partial matching (useful for names with slight differences)
                    # Clean up search value - remove commas, extra spaces, normalize
                    search_clean = search_val.lower().replace(',', '').strip()
                    search_parts = [part.strip() for part in search_clean.split() if part.strip()]
                    
                    if len(search_parts) >= 2:  # Name has at least first and last
                        for valid_val in valid_list:
                            valid_clean = str(valid_val).lower().replace(',', '').strip()
                            valid_lower = str(valid_val).lower()
                            
                            # Method 1: Check if main name parts appear in valid value
                            main_parts = search_parts[:2]  # First and last name
                            if all(part in valid_lower for part in main_parts):
                                return valid_val
                            
                            # Method 2: Check if cleaned versions match better
                            if all(part in valid_clean for part in main_parts):
                                return valid_val
                                
                            # Method 3: Try with institution if present (more than 2 parts)
                            if len(search_parts) >= 3:
                                # Look for institution match too
                                key_parts = search_parts[:2] + search_parts[-2:]  # First, last, and last 2 words
                                if all(part in valid_lower for part in key_parts[:2]) and \
                                   any(part in valid_lower for part in key_parts[2:]):
                                    return valid_val
                    
                    return None
                
                matched_user = find_matching_value(search_name, valid_users)
                
                if matched_user:
                    if matched_user != search_name:
                        return matched_user, f"✅ **Found user:** '{search_name}' → '{matched_user}'"
                    else:
                        return matched_user, f"✅ **Found user:** '{matched_user}'"
                else:
                    # Try to find similar names for suggestions
                    search_clean = search_name.lower().replace(',', '').strip()
                    first_part = search_clean.split()[0] if search_clean else ''
                    
                    similar_users = []
                    if first_part:
                        for user in valid_users[:50]:  # Check first 50 for performance
                            if first_part in str(user).lower():
                                similar_users.append(str(user))
                    
                    error_msg = f"❌ **User not found:** '{search_name}'\n"
                    if similar_users:
                        error_msg += f"💡 **Similar names:** {', '.join(similar_users[:3])}"
                        if len(similar_users) > 3:
                            error_msg += f" ... and {len(similar_users) - 3} more"
                    
                    return None, error_msg
                    
        except Exception as e:
            return None, f"❌ **User lookup failed:** {str(e)}"

    async def _get_user_data_python(self, args: Dict[str, Any]) -> List[TextContent]:
        """Get user-specific usage data by finding the right user first"""
        
        access_id = args["access_id"]
        start_date = args["start_date"]
        end_date = args["end_date"]
        realm = args.get("realm", "Jobs")
        statistic = args.get("statistic", "total_cpu_hours")
        
        # Validate date range first
        date_error = self._validate_date_range(start_date, end_date)
        if date_error:
            return [TextContent(type="text", text=date_error)]
        
        if not self.api_token:
            return [TextContent(type="text", text="❌ No API token configured")]
        
        result = f"🎯 **User Data Query**\n\n"
        result += f"**Search:** {access_id}\n"
        result += f"**Period:** {start_date} to {end_date}\n"
        result += f"**Metric:** {statistic}\n\n"
        
        # Step 1: Find the actual user using smart matching
        matched_user, status_msg = await self._smart_find_user(access_id, realm)
        result += status_msg + "\n\n"
        
        if matched_user:
            # Step 2: Get data using the matched user (bypass validation by calling get_raw_data with exact match)
            raw_data_args = {
                "realm": realm,
                "dimension": "person", 
                "metric": statistic,
                "filters": {"person": [matched_user]},
                "start_date": start_date,
                "end_date": end_date,
                "dataset_type": "aggregate",
                "show_progress": False
            }
            
            # Call get_raw_data with the exact matched name (should pass validation)
            result_content = await self._get_raw_data(raw_data_args)
            raw_result = result_content[0].text
            
            # Extract and reformat results
            if "**Results Summary:**" in raw_result:
                results_start = raw_result.find("**Results Summary:**")
                result += raw_result[results_start:]
            else:
                result += raw_result
        else:
            result += "💡 Try using get_smart_filters(dimension='person', search_prefix='...') to find the correct name format"
            
        return [TextContent(type="text", text=result)]
    async def _test_data_framework(self) -> List[TextContent]:
        """Test if we can use XDMoD data analytics framework"""
        
        result = "🧪 **XDMoD Data Analytics Framework Test**\n\n"
        
        # Test official xdmod-data package
        try:
            import xdmod_data
            result += f"✅ Found xdmod-data v{getattr(xdmod_data, '__version__', 'unknown')}\n"
            
            # Test basic functionality
            from xdmod_data import warehouse
            if hasattr(warehouse, 'DataWarehouse'):
                result += "✅ DataWarehouse class available\n"
                
                if self.api_token:
                    try:
                        # Set token in environment for the framework
                        os.environ['XDMOD_API_TOKEN'] = self.api_token
                        
                        with warehouse.DataWarehouse(xdmod_host=self.base_url) as dw:
                            result += "✅ DataWarehouse instance created successfully\n"
                            
                            # Test basic API call
                            try:
                                # Check available methods
                                methods = [m for m in dir(dw) if not m.startswith('_')]
                                result += f"✅ Framework ready - Available methods: {', '.join(methods[:5])}\n"
                            except Exception as api_error:
                                result += f"⚠️ API test failed: {str(api_error)}\n"
                            
                    except Exception as client_error:
                        result += f"❌ Client creation failed: {str(client_error)}\n"
                else:
                    result += "⚠️ No API token - cannot test client creation\n"
            else:
                result += "❌ DataWarehouse class not found\n"
            
            return [TextContent(type="text", text=result)]
            
        except ImportError:
            result += "❌ xdmod-data not found\n"
            
        result += "\n**Status:**\n"
        result += "- Official framework should be installed with: pip install xdmod-data\n"
        result += "- This provides the proper Python API for XDMoD data access\n"
        
        return [TextContent(type="text", text=result)]
    
    async def _get_chart_data(self, args: Dict[str, Any]) -> List[TextContent]:
        """Get chart data for visualization and analysis"""
        
        realm = args.get("realm", "Jobs")
        dimension = args.get("dimension")
        metric = args.get("metric", "total_cpu_hours")
        start_date = args["start_date"]
        end_date = args["end_date"] 
        filters = args.get("filters", {})
        limit = args.get("limit", 20)
        
        # Validate date range first
        date_error = self._validate_date_range(start_date, end_date)
        if date_error:
            return [TextContent(type="text", text=date_error)]
        
        # Validate required dimension parameter
        if not dimension:
            return [TextContent(type="text", text="❌ **Missing required parameter 'dimension'. See xdmod-python-reference.md for complete list. Common: person, resource, institution, pi, queue, jobsize.**")]
        
        if not self.api_token:
            return [TextContent(type="text", text="❌ No API token configured")]
        
        # Initialize result string
        result = ""
        
        # Check for common dimension name mistakes
        dimension_corrections = {
            'field_of_science': 'fieldofscience',
            'pi_institution': 'pi_institution',
            'user_institution': 'institution',
            'system_username': 'username'
        }
        
        if dimension in dimension_corrections:
            corrected = dimension_corrections[dimension]
            result += f"ℹ️ **Note**: Using '{corrected}' instead of '{dimension}'\n\n"
            dimension = corrected
            
        result += f"📊 **Chart Data: {metric} by {dimension}**\n\n"
        result += f"**Realm:** {realm}\n"
        result += f"**Period:** {start_date} to {end_date}\n"
        result += f"**Grouping:** {dimension}\n"
        result += f"**Metric:** {metric}\n\n"
        
        if filters:
            result += f"**Filters:** {filters}\n\n"
        
        try:
            from xdmod_data.warehouse import DataWarehouse
            
            os.environ['XDMOD_API_TOKEN'] = self.api_token
            load_dotenv()
            
            dw = DataWarehouse(xdmod_host=self.base_url)
            
            with dw:
                try:
                    # Get the chart data using the framework with smart filter validation
                    processed_filters = None
                    filter_warnings = []
                    
                    if filters and isinstance(filters, dict) and len(filters) > 0:
                        # Use smart validation to improve user experience
                        processed_filters, filter_warnings = await self._validate_filters_with_smart_matching(dw, filters, realm, False)
                    
                    # Display filter warnings
                    if filter_warnings:
                        result += "**Filter Validation:**\n"
                        for warning in filter_warnings:
                            result += f"{warning}\n"
                        result += "\n"
                    
                    # Get chart data using provided dimension - don't pass filters parameter if None
                    if processed_filters is not None:
                        chart_data = await self._xdmod_call(dw.get_data,
                            duration=(start_date, end_date),
                            realm=realm,
                            dimension=dimension,
                            metric=metric,
                            dataset_type='aggregate',
                            filters=processed_filters
                        )
                    else:
                        chart_data = await self._xdmod_call(dw.get_data,
                            duration=(start_date, end_date),
                            realm=realm,
                            dimension=dimension,
                            metric=metric,
                            dataset_type='aggregate'
                        )
                    
                    if chart_data is not None:
                        result += f"✅ **Chart data retrieved successfully!**\n\n"
                        
                        # Handle different data types
                        if isinstance(chart_data, pd.Series):
                            result += f"**Data Type:** Series (dimension values with metrics)\n"
                            result += f"**Total Items:** {len(chart_data)}\n\n"
                            
                            # Show top results limited by limit parameter
                            top_data = chart_data.head(limit) if len(chart_data) > limit else chart_data
                            
                            result += f"**Top {len(top_data)} Results:**\n"
                            for name, value in top_data.items():
                                if pd.notna(value):
                                    result += f"• **{name}**: {value:,.1f}\n"
                            
                            # Summary statistics
                            if len(chart_data) > 0:
                                result += f"\n**Summary Statistics:**\n"
                                result += f"• Total: {chart_data.sum():,.1f}\n"
                                result += f"• Average: {chart_data.mean():,.1f}\n"
                                result += f"• Maximum: {chart_data.max():,.1f}\n"
                                result += f"• Minimum: {chart_data.min():,.1f}\n"
                                
                        elif isinstance(chart_data, pd.DataFrame):
                            result += f"**Data Type:** DataFrame\n"
                            result += f"**Shape:** {chart_data.shape}\n"
                            result += f"**Columns:** {list(chart_data.columns)}\n\n"
                            
                            # Show sample data
                            sample_data = chart_data.head(limit)
                            result += f"**Sample Data ({len(sample_data)} rows):**\n"
                            result += sample_data.to_string() + "\n\n"
                            
                            # Summary for numeric columns
                            numeric_cols = chart_data.select_dtypes(include=[np.number]).columns
                            if len(numeric_cols) > 0:
                                result += f"**Numeric Summary:**\n"
                                summary = chart_data[numeric_cols].describe()
                                result += summary.to_string() + "\n"
                        
                        elif hasattr(chart_data, 'data'):
                            # Framework response object
                            actual_data = chart_data.data
                            result += f"**Framework Response Object:**\n"
                            result += f"• Type: {type(actual_data)}\n"
                            result += f"• Content: {str(actual_data)[:500]}\n"
                            
                        else:
                            result += f"**Unexpected Data Type:** {type(chart_data)}\n"
                            result += f"**Content Preview:** {str(chart_data)[:500]}\n"
                    
                    else:
                        result += f"❌ **No chart data returned**\n"
                        result += f"This could indicate:\n"
                        result += f"• No data available for the specified period\n"
                        result += f"• Invalid dimension/metric combination\n"
                        result += f"• Access restrictions\n"
                        
                except Exception as data_error:
                    result += f"❌ **Chart data retrieval failed:** {str(data_error)}\n"
        
        except ImportError:
            return [TextContent(type="text", text="❌ xdmod-data framework not available")]
        except Exception as e:
            return [TextContent(type="text", text=f"❌ Framework error: {str(e)}")]
            
        return [TextContent(type="text", text=result)]
    
    async def _get_usage_with_nsf_context(self, args: Dict[str, Any]) -> List[TextContent]:
        """Get XDMoD usage data enriched with NSF funding context by calling NSF server"""
        
        researcher_name = args["researcher_name"]
        start_date = args["start_date"]
        end_date = args["end_date"]
        limit = args.get("limit", 5)
        
        # Validate date range first
        date_error = self._validate_date_range(start_date, end_date)
        if date_error:
            return [TextContent(type="text", text=date_error)]
        
        result = f"🔬 **Research Profile: {researcher_name}**\n\n"
        result += f"**Analysis Period:** {start_date} to {end_date}\n\n"
        
        try:
            # Step 1: Get NSF awards for this researcher (call NSF server)
            result += f"**Step 1: Searching NSF awards for {researcher_name}**\n"
            nsf_data = await self._call_nsf_server("find_nsf_awards_by_pi", {
                "pi_name": researcher_name,
                "limit": limit
            })
            
            # Step 2: Get XDMoD usage data using our framework
            result += f"\n**Step 2: Analyzing XDMoD usage patterns**\n"
            xdmod_data = await self._get_system_usage_context(start_date, end_date)
            
            # Step 3: Integrate the results
            result += f"\n**Step 3: Integration Analysis**\n"
            result += f"🏆 **NSF Funding Context:**\n{nsf_data}\n\n"
            result += f"📊 **XDMoD Usage Context:**\n{xdmod_data}\n\n"
            
            result += f"**🔗 Research Integration Insights:**\n"
            result += f"• Use ACCESS ID if available to get specific usage data\n"
            result += f"• Cross-reference funding periods with computational usage spikes\n"
            result += f"• Consider institutional usage patterns at researcher's institution\n"
            
        except Exception as e:
            result += f"❌ **Integration error:** {str(e)}\n"
            result += f"**Note:** Requires both NSF and XDMoD servers to be available\n"
        
        return [TextContent(type="text", text=result)]
    
    async def _analyze_funding_vs_usage(self, args: Dict[str, Any]) -> List[TextContent]:
        """Compare NSF funding vs XDMoD usage by integrating both servers"""
        
        award_number = args["nsf_award_number"]
        start_date = args["start_date"]
        end_date = args["end_date"]
        
        # Validate date range first
        date_error = self._validate_date_range(start_date, end_date)
        if date_error:
            return [TextContent(type="text", text=date_error)]
        
        result = f"💰 **Funding vs. Usage Analysis**\n\n"
        result += f"**NSF Award:** {award_number}\n"
        result += f"**Analysis Period:** {start_date} to {end_date}\n\n"
        
        try:
            # Step 1: Get NSF award details
            result += f"**Step 1: Retrieving NSF award details**\n"
            nsf_award = await self._call_nsf_server("get_nsf_award", {
                "award_number": award_number
            })
            
            # Step 2: Get XDMoD usage for the same period
            result += f"\n**Step 2: Analyzing computational usage**\n"
            usage_data = await self._get_system_usage_context(start_date, end_date)
            
            # Step 3: Compare funding with usage patterns
            result += f"\n**Step 3: Funding vs Usage Analysis**\n"
            result += f"🏆 **NSF Award Details:**\n{nsf_award}\n\n"
            result += f"📊 **System Usage During Period:**\n{usage_data}\n\n"
            
            result += f"**💡 Analysis Insights:**\n"
            result += f"• NSF funding supports computational research on ACCESS-CI resources\n"
            result += f"• Cross-reference award PI with XDMoD user data for specific usage\n"
            result += f"• Compare award timeline with usage patterns\n"
            result += f"• Use institutional analysis to see broader impact\n"
            
        except Exception as e:
            result += f"❌ **Analysis error:** {str(e)}\n"
            result += f"**Note:** Requires both NSF and XDMoD servers to be available\n"
        
        return [TextContent(type="text", text=result)]
    
    async def _institutional_research_profile(self, args: Dict[str, Any]) -> List[TextContent]:
        """Generate institutional research profile by integrating NSF and XDMoD data"""
        
        institution_name = args["institution_name"]
        start_date = args["start_date"]
        end_date = args["end_date"]
        top_researchers = args.get("top_researchers", 10)
        
        # Validate date range first
        date_error = self._validate_date_range(start_date, end_date)
        if date_error:
            return [TextContent(type="text", text=date_error)]
        
        result = f"🏛️ **Institutional Research Profile: {institution_name}**\n\n"
        result += f"**Analysis Period:** {start_date} to {end_date}\n\n"
        
        try:
            # Step 1: Get NSF awards for institution (primary only to avoid collaborations)
            result += f"**Step 1: Analyzing NSF funding portfolio**\n"
            nsf_data = await self._call_nsf_server("search_nsf_awards", {
                "institution": institution_name,
                "limit": top_researchers * 2,
                "primary_only": True  # Only show awards where institution is primary recipient
            })
            
            # Step 2: Get XDMoD usage patterns
            result += f"\n**Step 2: Analyzing computational resource utilization**\n"
            usage_data = await self._get_system_usage_context(start_date, end_date)
            
            # Step 3: Generate integrated profile
            result += f"\n**Step 3: Institutional Analysis**\n"
            result += f"🏆 **NSF Research Portfolio:**\n{nsf_data}\n\n"
            result += f"📊 **ACCESS-CI Usage Profile:**\n{usage_data}\n\n"
            
            result += f"**🎯 Strategic Insights:**\n"
            result += f"• Institution demonstrates computational research capacity\n"
            result += f"• NSF funding supports ACCESS-CI resource utilization\n"
            result += f"• Cross-reference specific researchers with XDMoD user data\n"
            result += f"• Track computational ROI relative to funding investment\n"
            
        except Exception as e:
            result += f"❌ **Profile generation error:** {str(e)}\n"
            result += f"**Note:** Requires both NSF and XDMoD servers to be available\n"
        
        return [TextContent(type="text", text=result)]
    
    async def _call_nsf_server(self, method: str, params: Dict[str, Any]) -> str:
        """Call the NSF Awards server for NSF-specific data via HTTP"""
        
        # Get NSF server endpoint from environment
        nsf_service_url = self._get_service_endpoint("nsf-awards")
        if not nsf_service_url:
            return f"❌ **NSF Server not available**\n" \
                   f"Configure ACCESS_MCP_SERVICES environment variable:\n" \
                   f"ACCESS_MCP_SERVICES=nsf-awards=http://localhost:3007\n\n" \
                   f"**Alternative**: Start NSF server with HTTP port:\n" \
                   f"```bash\n" \
                   f"PORT=3007 npx @access-mcp/nsf-awards\n" \
                   f"```"
        
        try:
            # Make HTTP request to NSF server
            response = requests.post(
                f"{nsf_service_url}/tools/{method}",
                json={"arguments": params},
                timeout=30
            )
            
            if response.status_code == 200:
                data = response.json()
                # Extract the text content from MCP response format
                if isinstance(data, dict) and "content" in data:
                    content = data["content"]
                    if isinstance(content, list) and len(content) > 0:
                        if "text" in content[0]:
                            return content[0]["text"]
                return str(data)
            else:
                error_msg = response.json().get("error", "Unknown error") if response.headers.get("content-type", "").startswith("application/json") else response.text
                return f"❌ **NSF Server Error ({response.status_code})**: {error_msg}"
                
        except requests.exceptions.Timeout:
            return f"⏰ **NSF Server Timeout**: Request took longer than 30 seconds"
        except requests.exceptions.ConnectionError:
            return f"🔌 **NSF Server Connection Error**: Could not connect to {nsf_service_url}\n" \
                   f"Ensure NSF server is running with HTTP service enabled"
        except Exception as e:
            return f"❌ **NSF Server Integration Error**: {str(e)}"
    
    def _get_service_endpoint(self, service_name: str) -> str:
        """Get service endpoint from environment configuration"""
        services = os.getenv("ACCESS_MCP_SERVICES", "")
        if not services:
            return None
            
        service_map = {}
        for service in services.split(","):
            if "=" in service:
                name, url = service.split("=", 1)
                service_map[name.strip()] = url.strip()
        
        return service_map.get(service_name)
    
    async def _get_system_usage_context(self, start_date: str, end_date: str) -> str:
        """Get system-wide usage context for the analysis period"""
        if not self.api_token:
            return "❌ No API token configured for XDMoD data access"
        
        try:
            from xdmod_data.warehouse import DataWarehouse
            
            os.environ['XDMOD_API_TOKEN'] = self.api_token
            load_dotenv()
            
            dw = DataWarehouse(xdmod_host=self.base_url)
            
            with dw:
                # Get system-wide usage data
                system_data = await self._xdmod_call(dw.get_data,
                    duration=(start_date, end_date),
                    realm="Jobs",
                    dimension="resource",
                    metric="total_cpu_hours",
                    dataset_type='aggregate'
                )
                
                if system_data is not None and not system_data.empty:
                    return f"✅ System-wide computational activity detected during analysis period\n" \
                           f"• Active resources show usage patterns consistent with funded research\n" \
                           f"• Data available for {len(system_data)} resources\n" \
                           f"• Use ACCESS ID queries for specific researcher usage data"
                else:
                    return "⚠️ Limited system usage data for the specified period"
                    
        except Exception as e:
            return f"❌ XDMoD data access error: {str(e)}"

    async def _validate_filters_with_smart_matching(self, dw, filters: dict, realm: str, show_progress: bool = False) -> tuple:
        """
        Validate and process filters with smart matching logic.
        Returns (processed_filters, filter_warnings)
        """
        processed_filters = {}
        filter_warnings = []
        
        for key, value in filters.items():
            # Validate filter values exist in the realm
            try:
                # Note: show_progress handled by calling function
                
                # Get valid values for this dimension in this realm
                filter_df = await self._xdmod_call(dw.get_filter_values, realm=realm, dimension=key)
                
                # Convert DataFrame to list of strings (same as smart filters)
                valid_values = filter_df['label'].tolist() if 'label' in filter_df.columns else filter_df.iloc[:, 0].tolist()
                
                # Helper function for robust name matching
                def find_matching_value(search_val, valid_list):
                    search_val = str(search_val).strip()
                    
                    # Try exact match first
                    if search_val in valid_list:
                        return search_val
                    
                    # Try case-insensitive match
                    for valid_val in valid_list:
                        if search_val.lower() == str(valid_val).lower().strip():
                            return valid_val
                    
                    # Try fuzzy matching for names (handles whitespace differences)
                    search_normalized = ' '.join(search_val.split())
                    for valid_val in valid_list:
                        valid_normalized = ' '.join(str(valid_val).split())
                        if search_normalized.lower() == valid_normalized.lower():
                            return valid_val
                    
                    return None
                
                # Process the filter value with robust matching
                if isinstance(value, list):
                    # Check each value in the list
                    valid_filter_values = []
                    invalid_values = []
                    
                    for v in value:
                        matched_value = find_matching_value(v, valid_values)
                        if matched_value is not None:
                            valid_filter_values.append(matched_value)
                            if matched_value != str(v).strip():
                                filter_warnings.append(f"ℹ️ Matched '{v}' to '{matched_value}' in {realm} realm")
                        else:
                            invalid_values.append(str(v))
                    
                    if valid_filter_values:
                        processed_filters[key] = valid_filter_values
                        
                    if invalid_values:
                        filter_warnings.append(f"⚠️ Values not found in {realm} realm for {key}: {invalid_values}")
                        # For person/name dimensions, suggest using smart filters
                        if key.lower() in ['person', 'pi', 'username']:
                            # Clean up the prefix suggestion - remove commas, use just first name part
                            first_invalid = invalid_values[0] if invalid_values else ''
                            clean_prefix = first_invalid.replace(',', '').split()[0].lower() if first_invalid else ''
                            filter_warnings.append(f"💡 Try get_smart_filters(dimension='{key}', search_prefix='{clean_prefix}') to find similar names")
                else:
                    # Single value
                    matched_value = find_matching_value(value, valid_values)
                    if matched_value is not None:
                        processed_filters[key] = [matched_value]
                        if matched_value != str(value).strip():
                            filter_warnings.append(f"ℹ️ Matched '{value}' to '{matched_value}' in {realm} realm")
                    else:
                        filter_warnings.append(f"⚠️ Value '{value}' not found in {realm} realm for {key}")
                        if key.lower() in ['person', 'pi', 'username']:
                            # Clean up the prefix suggestion for single values too
                            clean_prefix = str(value).replace(',', '').split()[0].lower() if str(value) else ''
                            filter_warnings.append(f"💡 Try get_smart_filters(dimension='{key}', search_prefix='{clean_prefix}') to find similar names")
                            
            except XDMoDUnavailableError:
                raise
            except Exception as e:
                # If validation fails, use the filter as-is with a warning
                if isinstance(value, list):
                    processed_filters[key] = value
                else:
                    processed_filters[key] = [value] if not isinstance(value, list) else value
                filter_warnings.append(f"⚠️ Could not validate filter {key}: {str(e)}")
        
        return processed_filters, filter_warnings

    def _validate_date_range(self, start_date: str, end_date: str) -> Optional[str]:
        """Validate date range and return error message if invalid"""
        try:
            from datetime import datetime
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")
            end_dt = datetime.strptime(end_date, "%Y-%m-%d")
            
            if end_dt < start_dt:
                return f"❌ **Date Range Error**: End date ({end_date}) cannot be before start date ({start_date})"
            
            # Check if dates are too far in the future
            from datetime import date
            today = date.today()
            if start_dt.date() > today:
                return f"⚠️ **Date Warning**: Start date ({start_date}) is in the future"
            
            return None
        except ValueError as e:
            return f"❌ **Date Format Error**: Invalid date format. Use YYYY-MM-DD format. Error: {str(e)}"

    async def _get_raw_data(self, args: Dict[str, Any]) -> List[TextContent]:
        """Get raw data from XDMoD with complex filtering and progress tracking"""
        
        realm = args.get("realm", "Jobs")
        dimension = args.get("dimension", None)
        metric = args.get("metric", "total_cpu_hours")
        start_date = args["start_date"]
        end_date = args["end_date"]
        filters = args.get("filters", {})
        aggregation_unit = args.get("aggregation_unit", "Auto")
        dataset_type = args.get("dataset_type", "timeseries")
        show_progress = args.get("show_progress", False)
        
        # Validate date range first
        date_error = self._validate_date_range(start_date, end_date)
        if date_error:
            return [TextContent(type="text", text=date_error)]
        
        # Check for common dimension name mistakes
        if dimension:
            dimension_corrections = {
                'field_of_science': 'fieldofscience',
                'pi_institution': 'pi_institution',
                'user_institution': 'institution',
                'system_username': 'username'
            }
            
            if dimension in dimension_corrections:
                corrected = dimension_corrections[dimension]
                # Note: This correction will be shown in the result output
                dimension = corrected
        
        if not self.api_token:
            return [TextContent(type="text", text="❌ No API token configured")]
        
        try:
            from xdmod_data.warehouse import DataWarehouse
            
            # Set token in environment
            os.environ['XDMOD_API_TOKEN'] = self.api_token
            load_dotenv()
            
            result = f"📊 **Raw Data Extraction**\n\n"
            result += f"**Query Parameters:**\n"
            result += f"• Realm: {realm}\n"
            result += f"• Metric: {metric}\n"
            result += f"• Dimension: {dimension if dimension else 'none (aggregate total)'}\n"
            result += f"• Period: {start_date} to {end_date}\n"
            result += f"• Dataset Type: {dataset_type}\n"
            result += f"• Aggregation: {aggregation_unit}\n"
            
            if filters:
                result += f"• Filters: {filters}\n"
            
            result += "\n"
            
            dw = DataWarehouse(xdmod_host=self.base_url)
            
            with dw:
                # Progress tracking for discovery phase
                if show_progress:
                    result += "🔍 Discovering available dimensions and metrics...\n"
                    
                # Build filter dictionary with complex filter support and validation
                processed_filters = {}
                filter_warnings = []
                
                if filters:
                    for key, value in filters.items():
                        # Validate filter values exist in the realm
                        try:
                            if show_progress:
                                result += f"🔍 Validating filter {key}...\n"
                            
                            # Get valid values for this dimension in this realm
                            filter_df = await self._xdmod_call(dw.get_filter_values, realm=realm, dimension=key)
                            
                            # Convert DataFrame to list of strings (same as smart filters)
                            valid_values = filter_df['label'].tolist() if 'label' in filter_df.columns else filter_df.iloc[:, 0].tolist()
                            
                            # Helper function for robust name matching
                            def find_matching_value(search_val, valid_list):
                                search_val = str(search_val).strip()
                                
                                # Try exact match first
                                if search_val in valid_list:
                                    return search_val
                                
                                # Try case-insensitive match
                                for valid_val in valid_list:
                                    if search_val.lower() == str(valid_val).lower().strip():
                                        return valid_val
                                
                                # Try fuzzy matching for names (handles whitespace differences)
                                search_normalized = ' '.join(search_val.split())
                                for valid_val in valid_list:
                                    valid_normalized = ' '.join(str(valid_val).split())
                                    if search_normalized.lower() == valid_normalized.lower():
                                        return valid_val
                                
                                # Try partial matching (useful for names with slight differences)
                                if key.lower() in ['person', 'pi', 'username']:
                                    # Clean up search value - remove commas, extra spaces, normalize
                                    search_clean = search_val.lower().replace(',', '').strip()
                                    search_parts = [part.strip() for part in search_clean.split() if part.strip()]
                                    
                                    if len(search_parts) >= 2:  # Name has at least first and last
                                        for valid_val in valid_list:
                                            valid_clean = str(valid_val).lower().replace(',', '').strip()
                                            valid_lower = str(valid_val).lower()
                                            
                                            # Method 1: Check if main name parts appear in valid value
                                            main_parts = search_parts[:2]  # First and last name
                                            if all(part in valid_lower for part in main_parts):
                                                return valid_val
                                            
                                            # Method 2: Check if cleaned versions match better
                                            if all(part in valid_clean for part in main_parts):
                                                return valid_val
                                                
                                            # Method 3: Try with institution if present (more than 2 parts)
                                            if len(search_parts) >= 3:
                                                # Look for institution match too
                                                key_parts = search_parts[:2] + search_parts[-2:]  # First, last, and last 2 words
                                                if all(part in valid_lower for part in key_parts[:2]) and \
                                                   any(part in valid_lower for part in key_parts[2:]):
                                                    return valid_val
                                
                                return None
                            
                            # Process the filter value with robust matching
                            if isinstance(value, list):
                                # Check each value in the list
                                valid_filter_values = []
                                invalid_values = []
                                
                                for v in value:
                                    matched_value = find_matching_value(v, valid_values)
                                    if matched_value is not None:
                                        valid_filter_values.append(matched_value)
                                        if matched_value != str(v).strip():
                                            filter_warnings.append(f"ℹ️ Matched '{v}' to '{matched_value}' in {realm} realm")
                                    else:
                                        invalid_values.append(str(v))
                                
                                if valid_filter_values:
                                    processed_filters[key] = valid_filter_values
                                    
                                if invalid_values:
                                    filter_warnings.append(f"⚠️ Values not found in {realm} realm for {key}: {invalid_values}")
                                    # For person/name dimensions, suggest using smart filters
                                    if key.lower() in ['person', 'pi', 'username']:
                                        # Clean up the prefix suggestion - remove commas, use just first name part
                                        first_invalid = invalid_values[0] if invalid_values else ''
                                        clean_prefix = first_invalid.replace(',', '').split()[0].lower() if first_invalid else ''
                                        filter_warnings.append(f"💡 Try get_smart_filters(dimension='{key}', search_prefix='{clean_prefix}') to find similar names")
                            else:
                                # Single value
                                matched_value = find_matching_value(value, valid_values)
                                if matched_value is not None:
                                    processed_filters[key] = [matched_value]
                                    if matched_value != str(value).strip():
                                        filter_warnings.append(f"ℹ️ Matched '{value}' to '{matched_value}' in {realm} realm")
                                else:
                                    filter_warnings.append(f"⚠️ Value '{value}' not found in {realm} realm for {key}")
                                    if key.lower() in ['person', 'pi', 'username']:
                                        # Clean up the prefix suggestion for single values too
                                        clean_prefix = str(value).replace(',', '').split()[0].lower() if str(value) else ''
                                        filter_warnings.append(f"💡 Try get_smart_filters(dimension='{key}', search_prefix='{clean_prefix}') to find similar names")
                                    
                        except XDMoDUnavailableError:
                            raise
                        except Exception as e:
                            # If validation fails, use the filter as-is with a warning
                            if isinstance(value, list):
                                processed_filters[key] = value
                            else:
                                processed_filters[key] = [value] if not isinstance(value, list) else value
                            filter_warnings.append(f"⚠️ Could not validate filter {key}: {str(e)}")
                
                # Display filter warnings with cross-realm suggestions
                if filter_warnings:
                    result += "\n**Filter Validation Warnings:**\n"
                    for warning in filter_warnings:
                        result += f"{warning}\n"
                    
                    result += "\n**💡 Troubleshooting Tips:**\n"
                    result += "• Use get_smart_filters() to see valid values for each dimension\n"
                    
                    # Suggest alternative realms for common cross-realm issues
                    if realm == "SUPREMM":
                        result += "• Some users exist in Jobs realm but not SUPREMM - try realm='Jobs' for broader user coverage\n"
                        result += "• For user analysis templates, consider user_computing_behavior (Jobs realm) instead of user_efficiency_profiling (SUPREMM)\n"
                    elif realm == "Jobs":
                        result += "• For performance metrics, try realm='SUPREMM' (may have different user coverage)\n"
                        result += "• For efficiency analysis, consider user_efficiency_profiling template with realm='SUPREMM'\n"
                    
                    result += "• Consider using get_smart_filters() with search_prefix for autocomplete-style filtering\n"
                    result += "• 🏆 **Template Suggestion**: Use get_analysis_template() to get pre-configured queries with validated filters\n\n"
                
                # Execute query with progress updates
                if show_progress:
                    result += "⏳ Executing query...\n"
                    start_time = time.time()
                
                try:
                    # Get the data - build kwargs dynamically to handle optional dimension
                    kwargs = {
                        'duration': (start_date, end_date),
                        'realm': realm,
                        'metric': metric,
                        'dataset_type': dataset_type,
                        'aggregation_unit': aggregation_unit
                    }
                    
                    # Only add dimension if it's not "none" 
                    if dimension and dimension.lower() != "none":
                        kwargs['dimension'] = dimension
                    
                    # Only add filters if there are any
                    if processed_filters:
                        kwargs['filters'] = processed_filters
                    
                    data = await self._xdmod_call(dw.get_data, **kwargs)
                    
                    if show_progress:
                        elapsed = time.time() - start_time
                        result += f"✅ Query completed in {elapsed:.2f} seconds\n\n"
                    
                    # Process and format results based on type
                    if data is not None and not data.empty:
                        
                        # Check if we need pagination based on data size
                        limit_param = args.get("limit", None)
                        show_full_data = True
                        data_for_display = data
                        
                        if isinstance(data, pd.DataFrame) and len(data) > 50:
                            # Large timeseries - apply pagination
                            if limit_param is None:
                                limit_param = 20  # Default limit for large datasets
                                show_full_data = False
                            data_for_display = data.head(limit_param)
                        elif isinstance(data, pd.Series) and len(data) > 100:
                            # Large aggregate data - apply pagination  
                            if limit_param is None:
                                limit_param = 50  # Default limit for large aggregate data
                                show_full_data = False
                            data_for_display = data.head(limit_param)
                        elif isinstance(data, pd.Series):
                            # Small Series - apply limit if specified
                            if limit_param is not None:
                                data_for_display = data.head(limit_param)
                        
                        result += f"**Results Summary:**\n"
                        
                        if isinstance(data, pd.DataFrame):
                            # Timeseries data
                            result += f"• Total data points: {len(data)}\n"
                            if not show_full_data:
                                result += f"• Showing first {len(data_for_display)} rows (use limit parameter to see more)\n"
                            result += f"• Time range: {data.index[0]} to {data.index[-1]}\n" if not data.empty else ""
                            result += f"• Columns: {', '.join(data.columns)}\n"
                            
                            # Statistical summary (always based on full data)
                            result += f"\n**Statistical Summary (full dataset):**\n"
                            numeric_cols = data.select_dtypes(include=['number']).columns
                            for col in numeric_cols[:3]:  # Limit to first 3 columns for readability
                                result += f"• {col}:\n"
                                result += f"  - Total: {data[col].sum():,.2f}\n"
                                result += f"  - Mean: {data[col].mean():,.2f}\n"
                                result += f"  - Min: {data[col].min():,.2f}\n"
                                result += f"  - Max: {data[col].max():,.2f}\n"
                            if len(numeric_cols) > 3:
                                result += f"  ... and {len(numeric_cols) - 3} more columns\n"
                            
                            # Show sample data (paginated)
                            sample_rows = min(10, len(data_for_display))
                            result += f"\n**Sample Data (first {sample_rows} rows):**\n"
                            result += "```\n"
                            
                            # Use more concise formatting
                            # Note: XDMoD uses nullable Float64Dtype, which requires lambda for float_format
                            if isinstance(data_for_display, pd.DataFrame):
                                if len(data_for_display.columns) > 4:
                                    # Too many columns - show subset
                                    display_cols = list(data_for_display.columns[:4])
                                    subset_df = data_for_display[display_cols]
                                    sample_df = subset_df.head(sample_rows)
                                    # Use lambda for float formatting to handle nullable Float64Dtype
                                    display_text = sample_df.to_string(max_colwidth=15, float_format=lambda x: f'{x:.1f}')
                                    result += display_text
                                    result += f"\n... and {len(data_for_display.columns) - 4} more columns"
                                else:
                                    sample_df = data_for_display.head(sample_rows)
                                    # Use lambda for float formatting to handle nullable Float64Dtype
                                    display_text = sample_df.to_string(max_colwidth=20, float_format=lambda x: f'{x:.2f}')
                                    result += display_text
                            elif isinstance(data_for_display, pd.Series):
                                # For Series, just show the values
                                sample_series = data_for_display.head(sample_rows)
                                # Use lambda for float formatting to handle nullable Float64Dtype
                                display_text = sample_series.to_string(float_format=lambda x: f'{x:.2f}')
                                result += display_text
                                
                            result += "\n```\n"
                            
                            if not show_full_data:
                                remaining = len(data) - len(data_for_display)
                                result += f"\n💡 **{remaining:,} more rows available** - use `limit: {len(data)}` to see all data\n"
                            
                        elif isinstance(data, pd.Series):
                            # Aggregate data 
                            result += f"• Total entries: {len(data)}\n"
                            if not show_full_data:
                                result += f"• Showing top {len(data_for_display)} entries (use limit parameter to see more)\n"
                            result += f"• Type: Aggregate totals\n"
                            if data.index.name:
                                result += f"• Grouped by: {data.index.name}\n"
                            
                            result += f"\n**Statistical Summary:**\n"
                            result += f"• Total: {data.sum():,.2f}\n"
                            result += f"• Mean: {data.mean():,.2f}\n"
                            result += f"• Min: {data.min():,.2f}\n"
                            result += f"• Max: {data.max():,.2f}\n"
                            
                            # Show entries - adaptive limit for aggregate data
                            if len(data) <= 50:
                                # Show all entries if reasonable number
                                result += f"\n**All {len(data)} entries (sorted by value):**\n"
                                result += "```\n"
                                display_data = data.nlargest(len(data))
                                for idx, value in display_data.items():
                                    result += f"{str(idx):<40} {value:>15,.2f}\n"
                                result += "```\n"
                            else:
                                # Show top 30 for larger datasets
                                result += f"\n**Top 30 of {len(data)} entries:**\n"
                                result += "```\n"
                                top_data = data.nlargest(30)
                                for idx, value in top_data.items():
                                    result += f"{str(idx):<40} {value:>15,.2f}\n"
                                result += f"\n... and {len(data) - 30} more entries\n"
                                result += "```\n"
                        
                        # Export format suggestion based on type
                        if isinstance(data, pd.DataFrame):
                            result += f"\n💡 **Tip:** Showing {len(data)} time points. "
                            result += "Try 'aggregation_unit' of Day, Month, Quarter, or Year to adjust granularity.\n"
                        else:
                            result += f"\n💡 **Tip:** Showing aggregate totals for {len(data)} entries. "
                            result += "Use dataset_type='timeseries' to see how values change over time.\n"
                    else:
                        result += "⚠️ No data found for the specified parameters.\n"
                        result += "Try adjusting the date range, filters, or dimension.\n"
                        
                except Exception as query_error:
                    error_msg = str(query_error)
                    
                    # Check for specific error types and provide targeted messages
                    if "400" in error_msg or "bad request" in error_msg.lower():
                        result += f"❌ **API Parameter Error**: {error_msg}\n"
                        result += "\n**Most likely causes:**\n"
                        result += "• Invalid date range (end date before start date)\n"
                        result += "• Invalid dimension or metric name\n"
                        result += "• Invalid filter values\n"
                    elif "500" in error_msg or "internal server error" in error_msg.lower():
                        result += f"❌ **Server Error**: The XDMoD API encountered an internal error\n"
                        result += f"**Technical details:** {error_msg}\n"
                        result += "\n**Common causes of server errors:**\n"
                        result += "• Date range issues (end date before start date)\n"
                        result += "• Invalid parameter combinations\n"
                        result += "• Temporary server issues\n"
                    elif "date" in error_msg.lower() and ("before" in error_msg.lower() or "after" in error_msg.lower()):
                        result += f"❌ **Date Range Error**: {error_msg}\n"
                        result += "\n**Fix:**\n"
                        result += f"• Ensure end_date ({end_date}) is after start_date ({start_date})\n"
                        result += "• Use YYYY-MM-DD format\n"
                        result += "• Check that dates are not too far in the future\n"
                    else:
                        result += f"❌ **Query Error**: {error_msg}\n"
                    
                    # Enhanced error messages with specific guidance
                    result += "\n**Troubleshooting:**\n"
                    
                    if "aggregation_unit" in error_msg.lower():
                        result += "• ✅ **Aggregation Unit**: Use 'Auto', 'Day', 'Month', 'Quarter', or 'Year' (case-sensitive)\n"
                    
                    if "dimension" in error_msg.lower():
                        result += f"• 🔍 **Available Dimensions**: Use describe_raw_fields(realm='{realm}') to see valid options\n"
                        result += "• 💡 **Common Dimensions**: person, resource, institution, pi, fieldofscience, jobsize\n"
                    
                    if "metric" in error_msg.lower():
                        result += f"• 📊 **Available Metrics**: Use describe_raw_fields(realm='{realm}', include_metrics=True)\n"
                        result += "• 💡 **Common Metrics**: total_cpu_hours, job_count, wall_hours, total_ace\n"
                    
                    if "filter" in error_msg.lower():
                        result += "• 🎯 **Filter Values**: Each dimension has specific valid values\n"
                        result += f"• 🔎 **Discover Values**: Use describe_raw_fields(realm='{realm}', include_filter_values=True)\n"
                        if filters:
                            filter_dims = list(filters.keys())[:3]  # Show first 3
                            result += f"• 📋 **Your Filters**: {', '.join(filter_dims)} - check these dimensions exist\n"
                    
                    result += f"• 🌐 **Realm Check**: Verify '{realm}' is correct with describe_raw_realms()\n"
                    result += "• 📚 **Full Discovery**: Run describe_raw_fields() first to understand the data structure\n"
                    
        except ImportError:
            result = "❌ XDMoD data framework not installed. Please install: pip install xdmod-data"
        except Exception as e:
            result = f"❌ Error: {str(e)}"
            
        return [TextContent(type="text", text=result)]

    async def _describe_raw_fields(self, args: Dict[str, Any]) -> List[TextContent]:
        """Discover available fields and dimensions for a realm"""
        
        realm = args.get("realm", "Jobs")
        include_metrics = args.get("include_metrics", True)
        include_filter_values = args.get("include_filter_values", False)
        
        if not self.api_token:
            return [TextContent(type="text", text="❌ No API token configured")]
        
        try:
            from xdmod_data.warehouse import DataWarehouse
            
            # Set token in environment
            os.environ['XDMOD_API_TOKEN'] = self.api_token
            load_dotenv()
            
            result = f"🔍 **Field Discovery for Realm: {realm}**\n\n"
            
            dw = DataWarehouse(xdmod_host=self.base_url)
            
            with dw:
                # Get dimensions
                try:
                    dimensions = await self._xdmod_call(dw.describe_dimensions, realm)
                    result += "**Available Dimensions:**\n"
                    if dimensions is not None and not dimensions.empty:
                        for _, dim in dimensions.iterrows():
                            dim_id = dim.name if hasattr(dim, 'name') else dim.get('id', 'unknown')
                            dim_label = dim.get('label', dim_id)
                            result += f"• {dim_label} (id: {dim_id})\n"
                            if 'description' in dim and dim['description']:
                                result += f"  - {dim['description']}\n"
                    else:
                        result += "• No dimensions available or realm not accessible\n"
                except XDMoDUnavailableError:
                    raise
                except Exception as dim_error:
                    result += f"• Error fetching dimensions: {str(dim_error)}\n"
                
                result += "\n"
                
                # Get metrics if requested
                if include_metrics:
                    try:
                        metrics = await self._xdmod_call(dw.describe_metrics, realm)
                        result += "**Available Metrics:**\n"
                        if metrics is not None and not metrics.empty:
                            # Group metrics by category if available
                            for _, metric in metrics.iterrows():
                                metric_id = metric.name if hasattr(metric, 'name') else metric.get('id', 'unknown')
                                metric_label = metric.get('label', metric_id)
                                metric_unit = metric.get('unit', '')
                                result += f"• {metric_label}"
                                if metric_unit:
                                    result += f" ({metric_unit})"
                                result += f" [id: {metric_id}]\n"
                                if 'description' in metric and metric['description']:
                                    result += f"  - {metric['description']}\n"
                        else:
                            result += "• No metrics available for this realm\n"
                    except XDMoDUnavailableError:
                        raise
                    except Exception as metric_error:
                        result += f"• Error fetching metrics: {str(metric_error)}\n"
                
                # Get sample filter values if requested
                if include_filter_values and dimensions is not None and not dimensions.empty:
                    result += "\n**Filter Values by Dimension:**\n"
                    
                    # Prioritize commonly used dimensions
                    priority_dims = ['resource', 'institution', 'fieldofscience', 'jobsize', 'pi', 'queue']
                    
                    # Get all dimension labels
                    all_dims = [(dim.name if hasattr(dim, 'name') else dim.get('id', 'unknown'), 
                                dim.get('label', dim.name if hasattr(dim, 'name') else dim.get('id', 'unknown'))) 
                               for _, dim in dimensions.iterrows()]
                    
                    # Sort by priority, then alphabetically
                    def dim_priority(dim_info):
                        dim_id, dim_label = dim_info
                        lower_label = dim_label.lower()
                        for i, priority in enumerate(priority_dims):
                            if priority in lower_label:
                                return (0, i)  # High priority
                        return (1, dim_label)  # Lower priority, alphabetical
                    
                    sorted_dims = sorted(all_dims, key=dim_priority)
                    
                    # Show values for top dimensions
                    shown_count = 0
                    max_dims_to_show = 8  # Show more dimensions
                    
                    for dim_id, dim_label in sorted_dims:
                        if shown_count >= max_dims_to_show:
                            break
                            
                        try:
                            values = await self._xdmod_call(dw.get_filter_values, realm, dim_label)
                            if values is not None and not values.empty:
                                result += f"\n• **{dim_label}** ({len(values)} values):\n"
                                
                                # Show more examples for key dimensions
                                sample_size = 10 if any(key in dim_label.lower() for key in priority_dims[:4]) else 5
                                sample_values = values.head(sample_size)
                                
                                for _, val in sample_values.iterrows():
                                    val_label = val.get('label', 'unknown')
                                    result += f"  - {val_label}\n"
                                
                                if len(values) > sample_size:
                                    result += f"  ... and {len(values) - sample_size} more values\n"
                                    
                                shown_count += 1
                        except XDMoDUnavailableError:
                            raise
                        except Exception:
                            pass  # Skip if can't get values for this dimension
                    
                    if shown_count == 0:
                        result += "• Unable to retrieve filter values for this realm\n"
                    elif len(all_dims) > max_dims_to_show:
                        result += f"\n💡 **Note**: Showing {shown_count} of {len(all_dims)} dimensions. "
                        result += "Use specific dimension queries for complete lists.\n"
                
                result += "\n💡 **Usage Tips:**\n"
                result += f"• Use dimension IDs with get_raw_data() for grouping\n"
                result += f"• Combine multiple metrics for comprehensive analysis\n"
                result += f"• Filter values can be used in the 'filters' parameter\n"
                
        except ImportError:
            result = "❌ XDMoD data framework not installed. Please install: pip install xdmod-data"
        except Exception as e:
            result = f"❌ Error: {str(e)}"
            
        return [TextContent(type="text", text=result)]

    async def _describe_raw_realms(self, args: Dict[str, Any]) -> List[TextContent]:
        """Discover all available XDMoD realms"""
        
        include_details = args.get("include_details", True)
        
        if not self.api_token:
            return [TextContent(type="text", text="❌ No API token configured")]
        
        try:
            from xdmod_data.warehouse import DataWarehouse
            
            # Set token in environment
            os.environ['XDMOD_API_TOKEN'] = self.api_token
            load_dotenv()
            
            result = "🌐 **Available XDMoD Realms**\n\n"
            
            dw = DataWarehouse(xdmod_host=self.base_url)
            
            with dw:
                try:
                    realms = await self._xdmod_call(dw.describe_realms)
                    
                    if realms is not None and not realms.empty:
                        for _, realm in realms.iterrows():
                            realm_id = realm.name if hasattr(realm, 'name') else realm.get('id', 'unknown')
                            realm_label = realm.get('label', realm_id)
                            result += f"**{realm_label}** (id: {realm_id})\n"
                            
                            if include_details:
                                # Add description if available
                                if 'description' in realm and realm['description']:
                                    result += f"  {realm['description']}\n"
                                
                                # Try to get dimension and metric counts
                                try:
                                    dims = await self._xdmod_call(dw.describe_dimensions, realm_id)
                                    metrics = await self._xdmod_call(dw.describe_metrics, realm_id)
                                    dim_count = len(dims) if dims is not None else 0
                                    metric_count = len(metrics) if metrics is not None else 0
                                    result += f"  • Dimensions: {dim_count}\n"
                                    result += f"  • Metrics: {metric_count}\n"
                                except XDMoDUnavailableError:
                                    raise
                                except Exception:
                                    pass  # Skip if can't get counts
                            
                            result += "\n"
                        
                        result += "**Common Realms:**\n"
                        result += "• **Jobs**: Traditional HPC job accounting data\n"
                        result += "• **SUPREMM**: Detailed job performance metrics (includes GPU)\n"
                        result += "• **Cloud**: Cloud resource usage and VM metrics\n"
                        result += "• **Storage**: Storage allocation and usage data\n"
                        result += "• **ResourceSpecifications**: Hardware and system specifications\n"
                        
                    else:
                        result += "⚠️ No realms discovered. This might indicate:\n"
                        result += "• Authentication issues\n"
                        result += "• XDMoD server configuration\n"
                        result += "• Network connectivity problems\n"
                        
                except Exception as realm_error:
                    result += f"❌ Error discovering realms: {str(realm_error)}\n"
                    result += "\n**Note:** Some XDMoD instances may not expose all realms via the API.\n"
                
        except ImportError:
            result = "❌ XDMoD data framework not installed. Please install: pip install xdmod-data"
        except Exception as e:
            result = f"❌ Error: {str(e)}"
            
        return [TextContent(type="text", text=result)]



    async def _get_smart_filters(self, args: Dict[str, Any]) -> List[TextContent]:
        """Get smart semantic filters using XDMoD's built-in filter discovery"""
        
        realm = args.get("realm", "Jobs")
        dimension = args.get("dimension", "resource") 
        category = args.get("category", "all")  # gpu, cpu, memory, storage, all
        limit = args.get("limit", 20)
        search_prefix = args.get("search_prefix", "")  # For autocomplete-style filtering
        force_large = args.get("force_large_dimensions", False)  # Override size limits
        
        if not self.api_token:
            return [TextContent(type="text", text="❌ No API token configured")]
        
        try:
            from xdmod_data.warehouse import DataWarehouse
            
            os.environ['XDMOD_API_TOKEN'] = self.api_token
            dw = DataWarehouse(xdmod_host=self.base_url)
            
            result = f"🔍 **Smart Semantic Filters for {dimension} in {realm}**\n\n"
            
            with dw:
                # Get all available filter values dynamically
                filter_df = await self._xdmod_call(dw.get_filter_values, realm, dimension)
                
                if filter_df.empty:
                    result += f"❌ No filter values found for {dimension} in {realm}\n"
                    return [TextContent(type="text", text=result)]
                
                # Convert to list of values
                all_values = filter_df['label'].tolist() if 'label' in filter_df.columns else filter_df.iloc[:, 0].tolist()
                
                result += f"**Found {len(all_values)} total {dimension} values**\n\n"
                
                # Check for large dimensions and provide guidance
                if len(all_values) > 1000 and not force_large and not search_prefix:
                    result += f"⚠️ **Large Dimension Warning ({len(all_values):,} values)**\n\n"
                    result += f"**Options for handling large dimensions:**\n"
                    result += f"• Use `search_prefix` parameter to filter (e.g., search_prefix='univ' for universities)\n"
                    result += f"• Use `force_large_dimensions=true` to see all categories (may be slow)\n"
                    result += f"• Consider using raw data queries with specific filters instead\n\n"
                    
                    if dimension.lower() in ["person", "username"]:
                        result += f"**💡 For users**: Try searching by name prefix or use thresholds in raw data queries\n"
                        result += f"**Example**: `search_prefix='smith'` or filter by CPU hours >1M in get_raw_data()\n\n"
                    elif dimension.lower() in ["institution", "pi_institution"]:  
                        result += f"**💡 For institutions**: Try university name prefixes or geographic filters\n"
                        result += f"**Examples**: `search_prefix='university'`, `search_prefix='california'`\n\n"
                    
                    # Show top 10 as preview
                    result += f"**Preview (first 10 values):**\n"
                    for value in sorted(all_values)[:10]:
                        result += f"• {value}\n"
                    result += f"• ... and {len(all_values) - 10:,} more\n\n"
                    
                    return [TextContent(type="text", text=result)]
                
                # Apply search prefix filtering if provided
                if search_prefix:
                    all_values = [v for v in all_values if search_prefix.lower() in str(v).lower()]
                    result += f"**Filtered to {len(all_values)} values matching '{search_prefix}'**\n\n"
                    
                    if not all_values:
                        result += f"❌ No values found matching '{search_prefix}'\n"
                        result += f"💡 Try a shorter prefix or check spelling\n"
                        return [TextContent(type="text", text=result)]
                
                # Categorize intelligently using built-in data
                categories = self._smart_categorize_values(all_values, dimension, category, search_prefix)
                
                # Display categorized results
                for cat_name, values in categories.items():
                    if values:
                        result += f"**{cat_name.replace('_', ' ').title()} ({len(values)} items):**\n"
                        display_values = values[:limit] if len(values) > limit else values
                        for value in display_values:
                            result += f"• {value}\n"
                        
                        if len(values) > limit:
                            result += f"• ... and {len(values) - limit} more\n"
                        result += f"\n"
                
                # Provide ready-to-use JSON format
                result += f"**📋 Template-Ready JSON:**\n"
                result += f"```json\n"
                result += f'"semantic_filters": {{\n'
                for cat_name, values in categories.items():
                    if values:
                        json_values = values[:10]  # Limit for template usability
                        result += f'  "{cat_name}": {{"{dimension}": {json_values}}},\n'
                result += f"}}\n```\n"
                
                # Usage guidance
                result += f"\n**💡 Usage:**\n"
                result += f"• Filters are live from current XDMoD data\n"
                result += f"• No manual maintenance required\n"
                result += f"• Copy JSON above directly into templates\n"
                result += f"• Use category='gpu|cpu|memory|storage' for specific types\n"
                
        except Exception as e:
            result += f"❌ **Error getting smart filters**: {str(e)}\n"
        
        return [TextContent(type="text", text=result)]
    
    def _smart_categorize_values(self, values: List[str], dimension: str, category: str, search_prefix: str = "") -> Dict[str, List[str]]:
        """Intelligently categorize filter values based on naming patterns"""
        
        categories = {
            "gpu_systems": [],
            "cpu_systems": [],
            "memory_systems": [],
            "storage_systems": [],
            "cloud_systems": [],
            "large_systems": [],
            "other_systems": []
        }
        
        if dimension.lower() == "resource":
            for value in values:
                value_lower = str(value).lower()
                
                # GPU systems
                if any(gpu_term in value_lower for gpu_term in ["gpu", "graphics", "ai", "cuda", "accelerated"]):
                    categories["gpu_systems"].append(value)
                # Storage systems  
                elif any(storage_term in value_lower for storage_term in ["ranch", "corral", "stockyard", "storage", "data"]):
                    categories["storage_systems"].append(value)
                # Cloud systems
                elif any(cloud_term in value_lower for cloud_term in ["cloud", "jetstream", "atmosphere"]):
                    categories["cloud_systems"].append(value)
                # Memory systems
                elif any(memory_term in value_lower for memory_term in ["em", "memory", "ookami", "shared"]):
                    categories["memory_systems"].append(value)
                # Large systems
                elif any(large_term in value_lower for large_term in ["frontera", "stampede", "longhorn", "leadership", "supercomputer"]):
                    categories["large_systems"].append(value)
                # Default to CPU
                else:
                    categories["cpu_systems"].append(value)
        
        elif dimension.lower() in ["queue", "qos"]:
            categories = {
                "interactive_queues": [],
                "batch_queues": [],
                "gpu_queues": [],
                "debug_queues": [],
                "priority_queues": []
            }
            
            for value in values:
                value_lower = str(value).lower()
                
                if any(term in value_lower for term in ["gpu", "cuda", "accelerated"]):
                    categories["gpu_queues"].append(value)
                elif any(term in value_lower for term in ["debug", "test", "dev"]):
                    categories["debug_queues"].append(value)
                elif any(term in value_lower for term in ["interactive", "normal", "shared"]):
                    categories["interactive_queues"].append(value)
                elif any(term in value_lower for term in ["priority", "urgent", "express", "high"]):
                    categories["priority_queues"].append(value)
                else:
                    categories["batch_queues"].append(value)
        
        elif dimension.lower() in ["fieldofscience", "field_of_science"]:
            categories = {
                "physical_sciences": [],
                "life_sciences": [],
                "engineering": [],
                "earth_environmental": [],
                "computer_data": [],
                "other_fields": []
            }
            
            # Based on actual XDMoD fieldofscience values
            science_domains = {
                "physical_sciences": ["physics", "chemistry", "astronomy", "materials", "atomic", "molecular", "optical", "condensed matter", "fluid", "plasma"],
                "life_sciences": ["biology", "medicine", "biochemistry", "biophysics", "cell biology", "genetics", "developmental", "behavioral", "clinical", "basic medicine"],
                "engineering": ["engineering", "computer science", "applied computer science", "artificial intelligence"],
                "earth_environmental": ["atmospheric", "climate", "geology", "environmental", "ecology", "agriculture", "forestry"],
                "computer_data": ["computer science", "applied computer science", "artificial intelligence", "intelligent systems"]
            }
            
            for value in values:
                value_lower = str(value).lower()
                categorized = False
                
                for category_name, keywords in science_domains.items():
                    if any(keyword in value_lower for keyword in keywords):
                        categories[category_name].append(value)
                        categorized = True
                        break
                
                if not categorized:
                    categories["other_fields"].append(value)
        
        else:
            # For other dimensions, provide smart grouping based on size
            if len(values) <= 50:
                categories = {"all_values": sorted(values)}
            else:
                # Alphabetical grouping for medium-sized dimensions  
                alpha_groups = {}
                for value in values:
                    first_char = str(value)[0].upper() if str(value) else "?"
                    if first_char not in alpha_groups:
                        alpha_groups[first_char] = []
                    alpha_groups[first_char].append(value)
                
                categories = {f"starts_with_{k}": sorted(v)[:20] for k, v in alpha_groups.items()}  # Limit each group
        
        # Filter by requested category
        if category != "all":
            category_key = f"{category}_systems" if dimension.lower() == "resource" else f"{category}_queues"
            if category_key in categories:
                return {category_key: categories[category_key]}
        
        return {k: v for k, v in categories.items() if v}  # Remove empty categories

    async def _get_analysis_template(self, args: Dict[str, Any]) -> List[TextContent]:
        """Get pre-configured query templates for common analyses"""
        
        analysis_type = args.get("analysis_type")
        list_templates = args.get("list_templates", False)
        
        # Analysis templates with semantic aliases and common filter values
        templates = {
            "institutional_comparison": {
                "description": "Compare computational resource usage across institutions",
                "config": {
                    "realm": "Jobs",
                    "dimension": "institution",
                    "metric": "total_cpu_hours",
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "top_institutions": "💡 Use get_smart_filters(dimension='institution') for current institutional values",
                    "california_unis": "💡 Use get_smart_filters(dimension='institution') and filter for California institutions",
                    "ivy_league": "💡 Use get_smart_filters(dimension='institution') and filter for Ivy League schools"
                },
                "example": "Compare CPU usage across top research institutions"
            },
            "field_trends": {
                "description": "Analyze usage trends by field of science over time",
                "config": {
                    "realm": "Jobs", 
                    "dimension": "fieldofscience",
                    "metric": "total_cpu_hours",
                    "dataset_type": "timeseries",
                    "aggregation_unit": "Month"
                },
                "semantic_filters": {
                    "computer_science": "💡 Use get_smart_filters(dimension='fieldofscience') and filter for computer science fields",
                    "life_sciences": "💡 Use get_smart_filters(dimension='fieldofscience') and filter for biological sciences", 
                    "physical_sciences": "💡 Use get_smart_filters(dimension='fieldofscience') and filter for physics/chemistry fields"
                },
                "example": "Track how different scientific fields use resources over time"
            },
            "resource_usage": {
                "description": "Compare usage patterns across different computational resources",
                "config": {
                    "realm": "Jobs",
                    "dimension": "resource", 
                    "metric": "total_cpu_hours",
                    "dataset_type": "timeseries",
                    "aggregation_unit": "Day"
                },
                "semantic_filters": {
                    "gpu_systems": "💡 Use get_smart_filters(dimension='resource', category='gpu') for current values",
                    "cpu_systems": "💡 Use get_smart_filters(dimension='resource', category='cpu') for current values", 
                    "large_systems": "💡 Use get_smart_filters(dimension='resource', category='large') for current values"
                },
                "example": "Compare daily usage across major HPC systems"
            },
            "individual_user_productivity": {
                "description": "Analyze individual user computational productivity patterns and identify optimization opportunities",
                "config": {
                    "realm": "Jobs",
                    "dimension": "person", 
                    "metric": "total_cpu_hours",
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "power_users": "💡 Use get_smart_filters(dimension='person') and apply CPU hours threshold filter (>5M CPU hours)",
                    "heavy_users": "💡 Use get_smart_filters(dimension='person') and apply CPU hours threshold filter (1-5M CPU hours)",
                    "moderate_users": "💡 Use get_smart_filters(dimension='person') and apply CPU hours threshold filter (100K-1M CPU hours)",
                    "light_users": "💡 Use get_smart_filters(dimension='person') and apply CPU hours threshold filter (<100K CPU hours)",
                    "community_accounts": "💡 Filter for community/shared user accounts using search patterns",
                    "high_job_count": "💡 Use get_smart_filters(dimension='person') and apply job count threshold filter (>10K jobs)"
                },
                "multi_metrics": ["total_cpu_hours", "job_count", "avg_processors", "avg_wallduration_hours"],
                "context_parameters": {
                    "power_user_threshold": 5000000,
                    "high_job_threshold": 10000,
                    "optimization_focus": "resource_efficiency"
                },
                "example": "Identify computational patterns and users who might benefit from optimization consulting"
            },
            "user_efficiency_profiling": {
                "description": "Profile user computational efficiency using SUPREMM performance metrics",
                "config": {
                    "realm": "SUPREMM",
                    "dimension": "person",
                    "metric": "avg_percent_cpu_user", 
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "highly_efficient": "💡 Filter for users with >90% CPU utilization for best practices analysis",
                    "moderately_efficient": "💡 Filter for users with 50-90% CPU utilization for optimization opportunities",
                    "inefficient": "💡 Filter for users with <50% CPU utilization for training opportunities",
                    "gpu_users": "💡 Use get_smart_filters for GPU-focused users needing specialized training",
                    "memory_intensive": "💡 Filter for users with high memory usage patterns (>80GB per core)"
                },
                "multi_metrics": ["avg_percent_cpu_user", "wall_time", "avg_max_memory_per_core", "job_count", "gpu_time"],
                "context_parameters": {
                    "efficiency_threshold": 90,
                    "training_opportunity_threshold": 50,
                    "focus": "optimization_consulting"
                },
                "example": "Identify users for optimization training and find efficiency best practices"
            },
            "user_computing_behavior": {
                "description": "Analyze user parallelism patterns and computational scaling behavior",
                "config": {
                    "realm": "Jobs",
                    "dimension": "person",
                    "metric": "avg_processors",
                    "dataset_type": "aggregate", 
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "serial_computing": "💡 Filter for users with avg_processors=1 for serial optimization training",
                    "small_parallel": "💡 Filter for users with 2-64 processors for small parallel analysis",
                    "medium_parallel": "💡 Filter for users with 65-1024 processors for medium parallel scaling",
                    "large_parallel": "💡 Filter for users with >1024 processors for large parallel analysis",
                    "extreme_parallel": "💡 Filter for users with >8K cores for advanced HPC consultation",
                    "serial_specialists": "💡 Filter for users with avg_processors=1 AND >1000 jobs",
                    "hpc_power_users": "💡 Filter for users with >1000 processors AND >1M CPU hours"
                },
                "multi_metrics": ["avg_processors", "total_cpu_hours", "job_count", "max_processors", "avg_wallduration_hours"],
                "context_parameters": {
                    "large_scale_threshold": 1024,
                    "extreme_scale_threshold": 8192,
                    "power_user_cpu_threshold": 1000000
                },
                "example": "Understand user scaling patterns and identify candidates for advanced HPC training"
            },
            "user_activity_timeline": {
                "description": "Analyze temporal usage patterns to understand user computational behavior over time",
                "config": {
                    "realm": "Jobs", 
                    "dimension": "person",
                    "metric": "total_cpu_hours",
                    "dataset_type": "timeseries",
                    "aggregation_unit": "Week"
                },
                "semantic_filters": {
                    "top_users": "💡 Filter for users with >1M total CPU hours for engagement tracking",
                    "burst_users": "💡 Identify users with high variance in weekly usage patterns",
                    "steady_users": "💡 Find users with consistent weekly computational patterns",
                    "seasonal_users": "💡 Identify users with academic calendar usage patterns",
                    "new_users": "💡 Track recently active users for onboarding optimization",
                    "growing_users": "💡 Identify users with increasing computational usage trends"
                },
                "multi_metrics": ["total_cpu_hours", "job_count", "avg_processors"],
                "context_parameters": {
                    "variance_threshold": 0.5,
                    "consistency_threshold": 0.2,
                    "new_user_window": 180
                },
                "example": "Track user engagement patterns and predict system load from user behavior"
            },
            "job_size_analysis": {
                "description": "Understand job size distribution and resource utilization efficiency",
                "config": {
                    "realm": "Jobs",
                    "dimension": "jobsize",
                    "metric": "total_cpu_hours", 
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "small_jobs": "💡 Use get_smart_filters(dimension='jobsize') and filter for small job categories",
                    "medium_jobs": "💡 Use get_smart_filters(dimension='jobsize') and filter for medium job categories",
                    "large_jobs": "💡 Use get_smart_filters(dimension='jobsize') and filter for large job categories"
                },
                "example": "Analyze how job size affects resource utilization"
            },
            "gpu_usage": {
                "description": "Specialized GPU computational usage analysis",
                "config": {
                    "realm": "SUPREMM",
                    "dimension": "resource",
                    "metric": "gpu_time",
                    "dataset_type": "timeseries", 
                    "aggregation_unit": "Day"
                },
                "semantic_filters": {
                    "gpu_resources": "💡 Use get_smart_filters(dimension='resource', category='gpu') for current GPU resources",
                    "high_gpu_usage": "💡 Use get_smart_filters(dimension='resource', category='gpu') for GPU resources with high usage patterns"
                },
                "example": "Track GPU usage patterns and efficiency across systems"
            },
            "queue_analysis": {
                "description": "Analyze job queue performance and wait time patterns for operational insights",
                "config": {
                    "realm": "Jobs",
                    "dimension": "queue",
                    "metric": "total_waitduration_hours",
                    "dataset_type": "timeseries",
                    "aggregation_unit": "Day"
                },
                "semantic_filters": {
                    "interactive_queues": "💡 Use get_smart_filters(dimension='queue', category='interactive') for current values",
                    "batch_queues": "💡 Use get_smart_filters(dimension='queue', category='batch') for current values",
                    "gpu_queues": "💡 Use get_smart_filters(dimension='queue', category='gpu') for current values",
                    "debug_queues": "💡 Use get_smart_filters(dimension='queue', category='debug') for current values",
                    "priority_queues": "💡 Use get_smart_filters(dimension='queue', category='priority') for current values"
                },
                "multi_metrics": ["total_waitduration_hours", "avg_waitduration_hours", "job_count"],
                "example": "Monitor queue wait times to identify bottlenecks and optimize scheduling"
            },
            "allocation_efficiency": {
                "description": "Analyze resource allocation utilization and identify optimization opportunities",
                "config": {
                    "realm": "Jobs",
                    "dimension": "pi",
                    "metric": "total_cpu_hours",
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "high_allocations": "💡 Use get_smart_filters(dimension='pi') and sort by CPU hours to find top allocation holders",
                    "new_allocations": "💡 Filter for PIs with recent allocation activity using date ranges",
                    "underutilized": "💡 Filter for allocations below 50% utilization (compare charged vs. allocated)",
                    "overutilized": "💡 Filter for allocations above 90% utilization for expansion candidates"
                },
                "multi_metrics": ["total_cpu_hours", "total_su_charged", "job_count", "avg_cpu_hours"],
                "context_parameters": {
                    "utilization_threshold": 0.7,
                    "allocation_size_filter": ">100000"
                },
                "example": "Identify unused allocations and optimize resource distribution"
            },
            "performance_efficiency": {
                "description": "Analyze job performance and computational throughput patterns",
                "config": {
                    "realm": "Jobs",
                    "dimension": "resource",
                    "metric": "total_cpu_hours",
                    "dataset_type": "timeseries",
                    "aggregation_unit": "Day"
                },
                "semantic_filters": {
                    "cpu_intensive": "💡 Use get_smart_filters(dimension='resource', category='cpu') for current CPU resources",
                    "gpu_intensive": "💡 Use get_smart_filters(dimension='resource', category='gpu') for current GPU resources",
                    "memory_intensive": "💡 Use get_smart_filters(dimension='resource', category='memory') for memory-intensive resources",
                    "io_intensive": "💡 Use get_smart_filters(dimension='resource', category='storage') for I/O intensive resources"
                },
                "multi_metrics": ["total_cpu_hours", "avg_cpu_hours", "job_count", "avg_waitduration_hours"],
                "context_parameters": {
                    "efficiency_threshold": 0.8,
                    "min_job_duration": 1
                },
                "example": "Monitor computational efficiency and identify performance optimization opportunities"
            },
            "multi_node_scaling": {
                "description": "Analyze parallel job scaling efficiency and multi-node utilization patterns",
                "config": {
                    "realm": "Jobs", 
                    "dimension": "nodecount",
                    "metric": "total_cpu_hours",
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "single_node": "💡 Use get_smart_filters(dimension='nodecount') and filter for single node jobs",
                    "small_parallel": "💡 Use get_smart_filters(dimension='nodecount') and filter for small parallel ranges",
                    "medium_parallel": "💡 Use get_smart_filters(dimension='nodecount') and filter for medium parallel ranges",
                    "large_parallel": "💡 Use get_smart_filters(dimension='nodecount') and filter for large parallel ranges",
                    "massive_parallel": "💡 Use get_smart_filters(dimension='nodecount') and filter for massive parallel ranges"
                },
                "multi_metrics": ["total_cpu_hours", "job_count", "avg_cpu_hours", "avg_waitduration_hours"],
                "context_parameters": {
                    "scaling_efficiency_threshold": 0.7,
                    "parallel_overhead_factor": 0.1
                },
                "example": "Understand parallel job scaling patterns and optimize multi-node efficiency"
            },
            "service_provider_comparison": {
                "description": "Compare performance and utilization across different ACCESS service providers",
                "config": {
                    "realm": "Jobs",
                    "dimension": "resource_organization",
                    "metric": "total_cpu_hours", 
                    "dataset_type": "timeseries",
                    "aggregation_unit": "Month"
                },
                "semantic_filters": {
                    "tacc_resources": "💡 Use get_smart_filters(dimension='resource', search_prefix='tacc') for TACC systems",
                    "ncsa_resources": "💡 Use get_smart_filters(dimension='resource', search_prefix='ncsa') for NCSA systems", 
                    "psc_resources": "💡 Use get_smart_filters(dimension='resource', search_prefix='psc') for PSC systems",
                    "sdsc_resources": "💡 Use get_smart_filters(dimension='resource', search_prefix='sdsc') for SDSC systems",
                    "iu_resources": "💡 Use get_smart_filters(dimension='resource', search_prefix='iu') for Indiana University systems"
                },
                "multi_metrics": ["total_cpu_hours", "job_count", "avg_waitduration_hours", "total_su_charged"],
                "context_parameters": {
                    "comparison_period": "quarterly",
                    "include_utilization_rates": True
                },
                "example": "Compare resource provider performance and identify optimal allocation strategies"
            },
            "grant_type_analysis": {
                "description": "Analyze computational resource usage patterns by funding source and grant type",
                "config": {
                    "realm": "Jobs",
                    "dimension": "granttype",
                    "metric": "total_cpu_hours",
                    "dataset_type": "aggregate", 
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "research_grants": "💡 Use get_smart_filters(dimension='granttype') and filter for research grant types",
                    "startup_grants": "💡 Use get_smart_filters(dimension='granttype') and filter for startup/exploration grants",
                    "education_grants": "💡 Use get_smart_filters(dimension='granttype') and filter for educational grant types",
                    "industry_grants": "💡 Use get_smart_filters(dimension='granttype') and filter for industry partnerships"
                },
                "multi_metrics": ["total_cpu_hours", "total_su_charged", "job_count", "unique_users"],
                "context_parameters": {
                    "grant_utilization_target": 0.85,
                    "include_allocation_trends": True
                },
                "example": "Understand how different funding mechanisms drive computational resource usage"
            },
            # Missing high-value templates based on feedback
            "multi_node_scaling": {
                "description": "Analyze parallel job scaling efficiency and multi-node utilization patterns",
                "config": {
                    "realm": "Jobs",
                    "dimension": "resource",
                    "metric": "avg_processors", 
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "single_node": "💡 Use get_smart_filters(dimension='resource') to find single-node systems",
                    "small_parallel": "💡 Filter jobs with 2-64 processors for small parallel analysis",
                    "large_parallel": "💡 Filter jobs with 65-1024 processors for large parallel scaling",
                    "massive_parallel": "💡 Filter jobs with >1024 processors for extreme-scale analysis"
                },
                "multi_metrics": ["avg_processors", "total_cpu_hours", "job_count", "avg_wallduration_hours"],
                "context_parameters": {
                    "small_parallel_threshold": 64,
                    "large_parallel_threshold": 1024,
                    "efficiency_focus": "scaling_patterns"
                },
                "example": "Understand job scaling efficiency and identify parallel computing optimization opportunities"
            },
            "service_provider_comparison": {
                "description": "Compare performance and usage patterns across ACCESS service providers",
                "config": {
                    "realm": "Jobs", 
                    "dimension": "resource",
                    "metric": "total_cpu_hours",
                    "dataset_type": "timeseries",
                    "aggregation_unit": "Month"
                },
                "semantic_filters": {
                    "tacc_resources": "💡 Use get_smart_filters(dimension='resource', search_prefix='tacc') for TACC systems",
                    "ncsa_resources": "💡 Use get_smart_filters(dimension='resource', search_prefix='ncsa') for NCSA systems", 
                    "psc_resources": "💡 Use get_smart_filters(dimension='resource', search_prefix='psc') for PSC systems",
                    "sdsc_resources": "💡 Use get_smart_filters(dimension='resource', search_prefix='sdsc') for SDSC systems"
                },
                "multi_metrics": ["total_cpu_hours", "job_count", "avg_waitduration_hours", "total_su_charged"],
                "context_parameters": {
                    "comparison_metrics": ["performance", "availability", "utilization"],
                    "provider_analysis": True
                },
                "example": "Compare ACCESS service provider performance to optimize allocation strategies"
            },
            "individual_user_productivity": {
                "description": "Analyze individual user computational productivity patterns for optimization consulting",
                "config": {
                    "realm": "Jobs",
                    "dimension": "person", 
                    "metric": "total_cpu_hours",
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "power_users": "💡 Use get_smart_filters(dimension='person') and filter for users with >5M CPU hours",
                    "community_accounts": "💡 Filter for shared/community accounts in user analysis",
                    "high_job_count": "💡 Filter for users with >10K jobs for efficiency opportunities"
                },
                "multi_metrics": ["total_cpu_hours", "job_count", "avg_processors", "avg_wallduration_hours"],
                "context_parameters": {
                    "power_user_threshold": 5000000,
                    "consulting_focus": "optimization_opportunities",
                    "publicly_available": True
                },
                "example": "Identify users for computational optimization consulting and efficiency training"
            },
            "user_efficiency_profiling": {
                "description": "Profile computational efficiency using performance metrics to identify training opportunities",
                "config": {
                    "realm": "SUPREMM",
                    "dimension": "person",
                    "metric": "avg_percent_cpu_user", 
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "highly_efficient": "💡 Filter for users with >90% CPU utilization for best practices",
                    "inefficient_users": "💡 Filter for users with <50% CPU utilization for training opportunities", 
                    "gpu_users": "💡 Use get_smart_filters for GPU-focused users needing specialized training"
                },
                "multi_metrics": ["avg_percent_cpu_user", "wall_time", "avg_max_memory_per_core", "job_count", "gpu_time"],
                "context_parameters": {
                    "efficiency_threshold": 90,
                    "training_opportunity_threshold": 50,
                    "realm_note": "SUPREMM realm required for performance metrics"
                },
                "example": "Identify users for efficiency training and discover computational best practices"
            },
            "user_computing_behavior": {
                "description": "Analyze user parallelism and computational scaling behavior patterns",
                "config": {
                    "realm": "Jobs",
                    "dimension": "person",
                    "metric": "avg_processors", 
                    "dataset_type": "aggregate",
                    "aggregation_unit": "Auto"
                },
                "semantic_filters": {
                    "serial_computing": "💡 Filter for users with avg_processors=1 for serial optimization training",
                    "extreme_parallel": "💡 Filter for users with >8K cores for advanced HPC consultation",
                    "hpc_power_users": "💡 Filter for users with >1000 processors AND >1M CPU hours"
                },
                "multi_metrics": ["avg_processors", "total_cpu_hours", "job_count", "max_processors", "avg_wallduration_hours"],
                "context_parameters": {
                    "large_scale_threshold": 1024,
                    "extreme_scale_threshold": 8192,
                    "power_user_cpu_threshold": 1000000
                },
                "example": "Understand user scaling patterns and identify candidates for advanced HPC training"
            },
            "user_activity_timeline": {
                "description": "Analyze temporal user engagement patterns and computational behavior over time", 
                "config": {
                    "realm": "Jobs",
                    "dimension": "person",
                    "metric": "total_cpu_hours",
                    "dataset_type": "timeseries", 
                    "aggregation_unit": "Week"
                },
                "semantic_filters": {
                    "top_users": "💡 Filter for users with >1M total CPU hours for engagement tracking",
                    "burst_users": "💡 Identify users with high variance in weekly usage patterns",
                    "steady_users": "💡 Find users with consistent weekly computational patterns",
                    "new_users": "💡 Track recently active users for onboarding optimization"
                },
                "multi_metrics": ["total_cpu_hours", "job_count", "avg_processors"],
                "context_parameters": {
                    "temporal_analysis": "weekly_patterns",
                    "engagement_tracking": True,
                    "user_lifecycle": "onboarding_to_expert"
                },
                "example": "Track user computational engagement over time and predict system load patterns"
            }
        }
        
        if list_templates:
            result = "📋 **Available Analysis Templates**\n\n"
            
            # Categorize templates by operational value
            operational_templates = [
                "queue_analysis", "allocation_efficiency", "performance_efficiency", 
                "multi_node_scaling", "service_provider_comparison", "grant_type_analysis"
            ]
            
            research_templates = [
                "field_trends", "resource_usage", "job_size_analysis", "gpu_usage"
            ]
            
            user_analysis_templates = [
                "individual_user_productivity", "user_efficiency_profiling", 
                "user_computing_behavior", "user_activity_timeline"
            ]
            
            basic_templates = ["institutional_comparison"]
            
            result += "🚀 **Operational Insights** (Recommended for system administrators):\n"
            for template_name in operational_templates:
                if template_name in templates:
                    template_info = templates[template_name]
                    metrics_info = f" • Multi-metric: {len(template_info.get('multi_metrics', []))} metrics" if 'multi_metrics' in template_info else ""
                    result += f"• **{template_name.replace('_', ' ').title()}**: {template_info['description']}{metrics_info}\n"
            
            result += f"\n👤 **User Analysis** (Individual user insights - data is publicly available):\n"
            for template_name in user_analysis_templates:
                if template_name in templates:
                    template_info = templates[template_name]
                    metrics_info = f" • Multi-metric: {len(template_info.get('multi_metrics', []))} metrics" if 'multi_metrics' in template_info else ""
                    result += f"• **{template_name.replace('_', ' ').title()}**: {template_info['description']}{metrics_info}\n"
            
            result += f"\n📊 **Research Analysis** (Great for scientific insights):\n"
            for template_name in research_templates:
                if template_name in templates:
                    template_info = templates[template_name]
                    result += f"• **{template_name.replace('_', ' ').title()}**: {template_info['description']}\n"
            
            result += f"\n📈 **Basic Analysis** (Simple comparisons):\n"
            for template_name in basic_templates:
                if template_name in templates:
                    template_info = templates[template_name]
                    result += f"• **{template_name.replace('_', ' ').title()}**: {template_info['description']}\n"
            
            result += f"\n💡 **Usage**: Use get_analysis_template(analysis_type='template_name') to get full configuration\n"
            result += f"🏆 **Smart Filters**: Dynamic semantic filters - no maintenance required!\n" 
            result += f"⚡ **Live Data**: Use get_smart_filters() to get current, categorized filter values\n"
            result += f"🔄 **Auto-Updated**: Filters stay current with XDMoD data automatically\n"
            return [TextContent(type="text", text=result)]
        
        if not analysis_type or analysis_type not in templates:
            result = f"❌ Unknown analysis type: '{analysis_type}'\n\n"
            result += "**Available templates:**\n"
            for name in templates.keys():
                result += f"• {name}\n"
            result += f"\n💡 Use list_templates=True to see detailed descriptions"
            return [TextContent(type="text", text=result)]
        
        template = templates[analysis_type]
        result = f"📊 **{analysis_type.replace('_', ' ').title()} Template**\n\n"
        result += f"**Description**: {template['description']}\n\n"
        
        result += "**Base Configuration:**\n"
        config = template['config']
        for key, value in config.items():
            result += f"• {key}: {value}\n"
        
        # Add multi-metrics info if available
        if 'multi_metrics' in template:
            result += f"\n**Available Metrics:**\n"
            for metric in template['multi_metrics']:
                result += f"• {metric}\n"
        
        # Add context parameters if available  
        if 'context_parameters' in template:
            result += f"\n**Context Parameters:**\n"
            for param, value in template['context_parameters'].items():
                result += f"• {param}: {value}\n"
        
        # Add validation notes if available
        if 'validation_notes' in template:
            result += f"\n**⚠️ Validation & Troubleshooting:**\n"
            for note in template['validation_notes']:
                result += f"• {note}\n"
        
        result += f"\n**Semantic Filter Options:**\n"
        for filter_name, filter_config in template['semantic_filters'].items():
            result += f"• **{filter_name}**: {filter_config}\n"
        
        # Add smart suggestions based on template type
        result += f"\n💡 **Smart Integration Suggestions:**\n"
        if analysis_type in ["performance_efficiency", "gpu_usage", "resource_usage"]:
            result += "• Use get_smart_filters(category='gpu') to find GPU systems automatically\n"
            result += "• Try get_smart_filters(category='cpu') for CPU-focused analysis\n"
        elif analysis_type in ["field_trends", "institutional_comparison"]:
            result += "• Use get_smart_filters(search_prefix='univ') to find universities\n"
            result += "• Try get_smart_filters(dimension='fieldofscience', category='computer_data') for AI/CS fields\n" 
        elif "user" in analysis_type:
            result += "• Consider cross-realm validation: some users exist in Jobs but not SUPREMM\n"
            result += "• Use get_smart_filters(dimension='person', force_large_dimensions=True) for autocomplete\n"
        
        result += f"• 🔗 **Template Chaining**: This analysis pairs well with "
        if analysis_type == "institutional_comparison":
            result += "field_trends and resource_usage templates\n"
        elif analysis_type == "field_trends": 
            result += "institutional_comparison and user_activity_timeline templates\n"
        elif "user" in analysis_type:
            result += "institutional_comparison and field_trends templates\n"
        else:
            result += "user analysis and institutional comparison templates\n"
        
        result += f"\n**Example Usage with get_raw_data():**\n"
        result += "```json\n"
        result += "{\n"
        for key, value in config.items():
            result += f'  "{key}": "{value}",\n'
        result += f'  "start_date": "2024-01-01",\n'
        result += f'  "end_date": "2024-12-31"'
        
        # Add example filters section
        result += ',\n  "filters": {"example": "Use get_smart_filters() to get current values"}'
        
        result += "\n}\n```\n"
        
        result += f"\n💡 **Pro Tips:**\n"
        result += f"• Copy configuration to get_raw_data() and customize date range and filters\n"
        if 'multi_metrics' in template:
            result += f"• Try different metrics: {', '.join(template['multi_metrics'][:3])}{'...' if len(template['multi_metrics']) > 3 else ''}\n"
        result += f"• Use semantic filters for quick domain-specific analysis\n"
        if 'context_parameters' in template:
            result += f"• Context parameters help interpret results in operational context"
        
        return [TextContent(type="text", text=result)]

async def async_main():
    """Async main entry point for the server"""
    server = XDMoDPythonServer()
    await server.start()


def main():
    """Synchronous wrapper for pipx/CLI entry point"""
    asyncio.run(async_main())


if __name__ == "__main__":
    main()