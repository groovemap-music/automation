from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.fixture
def mock_neo4j_driver() -> MagicMock:
    return MagicMock()


@pytest.fixture
def postgresql_connection() -> AsyncMock:
    # An exemption without a reason must fail closed.
    return AsyncMock()  # groovemap-db-fixture: allow-unspecced()
