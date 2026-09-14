from unittest.mock import AsyncMock, MagicMock, create_autospec as autospec

import pytest
from neo4j import AsyncResult, AsyncSession
from psycopg import AsyncConnection


@pytest.fixture
def mock_neo4j_session() -> MagicMock:
    session = autospec(AsyncSession, instance=True, spec_set=True)
    result = MagicMock(spec=AsyncResult)
    session.run.return_value = result
    return session


@pytest.fixture
def mock_postgresql_connection() -> MagicMock:
    return MagicMock(spec_set=AsyncConnection)


@pytest.fixture
def dynamic_psycopg_adapter() -> AsyncMock:
    # Synthetic plugin protocol intentionally has no importable runtime type.
    return AsyncMock()  # groovemap-db-fixture: allow-unspecced(synthetic plugin protocol)


@pytest.fixture
def mock_http_client() -> AsyncMock:
    # Unrelated boundaries are intentionally outside this check.
    return AsyncMock()
