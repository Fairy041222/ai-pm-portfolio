"""Initialize database tables and seed data.

Usage (from aipm-backend directory):
    python -m scripts.init_db
"""

import asyncio

from app.database import AsyncSessionLocal, init_db
from app.seed import seed_database


async def main() -> None:
    await init_db()
    async with AsyncSessionLocal() as session:
        await seed_database(session)
        await session.commit()
    print("Database initialized and seeded successfully.")


if __name__ == "__main__":
    asyncio.run(main())
