"""删除名称含「测试」或无效残留的模型记录。

Usage (from aipm-backend directory):
    python -m scripts.cleanup_test_models
"""

import asyncio

from sqlalchemy import delete, select, text

from app.database import AsyncSessionLocal, init_db
from app.models import ModelORM


async def main() -> None:
    await init_db()
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(ModelORM).where(
                ModelORM.name.like("%测试%")
                | ModelORM.name.like("%test%")
                | ModelORM.name.like("%Test%")
            )
        )
        rows = result.scalars().all()
        if not rows:
            print("未发现名称含「测试」的模型，无需清理。")
            return

        ids = [m.id for m in rows]
        names = [m.name for m in rows]
        await session.execute(delete(ModelORM).where(ModelORM.id.in_(ids)))
        await session.commit()
        print(f"已删除 {len(ids)} 条测试模型：{names}")


if __name__ == "__main__":
    asyncio.run(main())
