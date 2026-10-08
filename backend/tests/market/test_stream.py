"""Tests for the SSE stream router factory."""

from app.market.cache import PriceCache
from app.market.stream import create_stream_router


def test_each_call_returns_independent_router():
    """Two apps in one process must not share or double-register routes."""
    r1 = create_stream_router(PriceCache())
    r2 = create_stream_router(PriceCache())

    assert r1 is not r2
    assert [route.path for route in r1.routes] == ["/api/stream/prices"]
    assert [route.path for route in r2.routes] == ["/api/stream/prices"]
