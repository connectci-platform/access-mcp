"""An unreachable XDMoD must fail fast and must not stall the event loop.

xdmod-data issues its requests with no timeout, so a dead upstream would
otherwise hang each tool call for minutes and block every other session.
"""

import asyncio
import os
import sys
import threading
import time
from unittest.mock import patch

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from xdmod_mcp_data import server as server_module
from xdmod_mcp_data.server import XDMoDPythonServer


class HangingWarehouse:
    """Stands in for DataWarehouse when XDMoD never answers."""

    def __init__(self, xdmod_host=None):
        self.release = threading.Event()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.release.set()

    def describe_realms(self):
        self.release.wait(5)


@pytest.mark.asyncio
async def test_unreachable_xdmod_fails_fast_with_clear_error():
    server = XDMoDPythonServer()
    with patch.dict(os.environ, {'XDMOD_API_TOKEN': 'test-token'}), \
         patch('xdmod_data.warehouse.DataWarehouse', HangingWarehouse), \
         patch.object(server_module, 'XDMOD_CALL_TIMEOUT_SECONDS', 0.2):
        server._env_api_token = 'test-token'
        started = time.monotonic()
        result = await server._describe_raw_realms({})
        elapsed = time.monotonic() - started

    assert elapsed < 2
    assert "did not respond within 0.2s" in result[0].text


@pytest.mark.asyncio
async def test_hanging_xdmod_call_does_not_block_event_loop():
    server = XDMoDPythonServer()
    ticks = 0

    async def ticker():
        nonlocal ticks
        while True:
            await asyncio.sleep(0.01)
            ticks += 1

    with patch.dict(os.environ, {'XDMOD_API_TOKEN': 'test-token'}), \
         patch('xdmod_data.warehouse.DataWarehouse', HangingWarehouse), \
         patch.object(server_module, 'XDMOD_CALL_TIMEOUT_SECONDS', 0.5):
        server._env_api_token = 'test-token'
        ticker_task = asyncio.create_task(ticker())
        await server._describe_raw_realms({})
        ticker_task.cancel()

    # A blocked loop would let the ticker run zero times during the 0.5s wait.
    assert ticks >= 10


class CountingHangingWarehouse(HangingWarehouse):
    calls = 0

    def __getattr__(self, name):
        def hang(*args, **kwargs):
            type(self).calls += 1
            self.release.wait(5)
        return hang


@pytest.mark.asyncio
@pytest.mark.parametrize("handler, args", [
    ("_describe_raw_fields", {"realm": "Jobs"}),
    ("_get_raw_data", {
        "start_date": "2026-09-01",
        "end_date": "2026-09-30",
        "filters": {"resource": "Delta", "pi": "Smith"},
    }),
])
async def test_per_item_loops_stop_after_first_timeout(handler, args):
    """Handlers that skip a failed item and try the next must not wait out
    one timeout per item once XDMoD is known to be unreachable."""
    server = XDMoDPythonServer()
    CountingHangingWarehouse.calls = 0
    with patch.dict(os.environ, {'XDMOD_API_TOKEN': 'test-token'}), \
         patch('xdmod_data.warehouse.DataWarehouse', CountingHangingWarehouse), \
         patch.object(server_module, 'XDMOD_CALL_TIMEOUT_SECONDS', 0.1):
        server._env_api_token = 'test-token'
        result = await getattr(server, handler)(args)

    assert CountingHangingWarehouse.calls == 1
    assert "did not respond within 0.1s" in result[0].text
