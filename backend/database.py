import os
import re
from collections.abc import Generator
from pathlib import Path

import pymysql
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import URL
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


# Load .env from the main project folder.
BASE_DIR = Path(__file__).resolve().parent.parent
load_dotenv(BASE_DIR / ".env")


# MySQL settings
DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_USER = os.getenv("DB_USER", "root")
DB_PASSWORD = os.getenv("DB_PASSWORD", "")
DB_NAME = os.getenv("DB_NAME", "careeros_db")

# Validate the database name before using it in CREATE DATABASE.
if not re.fullmatch(r"[A-Za-z0-9_]{1,64}", DB_NAME):
    raise ValueError(
        "DB_NAME must contain only letters, numbers, or underscores "
        "and be 1–64 characters long."
    )


# URL.create handles special characters in your password.
DATABASE_URL = URL.create(
    drivername="mysql+pymysql",
    username=DB_USER,
    password=DB_PASSWORD,
    host=DB_HOST,
    port=DB_PORT,
    database=DB_NAME,
    query={"charset": "utf8mb4"},
)


# Configure the database connection pool.
engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_recycle=1800,
    connect_args={"connect_timeout": 10},
    echo=False,
)


# Create a separate session for each API request.
SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    expire_on_commit=False,
)


# All SQLAlchemy models will inherit from this class.
class Base(DeclarativeBase):
    pass


def ensure_database_exists() -> None:
    """Create the database if it does not already exist."""
    connection = pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        charset="utf8mb4",
        connect_timeout=10,
        autocommit=True,
    )

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
                "CHARACTER SET utf8mb4 "
                "COLLATE utf8mb4_unicode_ci"
            )
    finally:
        connection.close()


def init_db() -> None:
    """Create the database and any missing model tables."""
    ensure_database_exists()

    # Register all models before creating their tables.
    from . import models  # noqa: F401

    Base.metadata.create_all(bind=engine)


def get_db() -> Generator[Session, None, None]:
    """Provide a database session to a FastAPI endpoint."""
    db = SessionLocal()

    try:
        yield db
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()