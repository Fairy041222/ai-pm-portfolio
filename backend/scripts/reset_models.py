"""清空所有模型配置，恢复空白初始状态。

Usage (from aipm-backend directory):
    python -m scripts.reset_models
"""

import asyncio

from sqlalchemy import delete, text

from app.database import AsyncSessionLocal, init_db
from app.models import ModelORM
from app.seed import DEFAULT_MODELS_META_KEY


async def main() -> None:
    await init_db()
    async with AsyncSessionLocal() as session:
        result = await session.execute(delete(ModelORM))
        deleted = result.rowcount if result.rowcount is not None else 0
        await session.execute(
            text("DELETE FROM app_meta WHERE key = :key"),
            {"key": DEFAULT_MODELS_META_KEY},
        )
        await session.commit()
    print(f"已清空 models 表（删除 {deleted} 条），请在前端「添加模型」重新配置。")


if __name__ == "__main__":
    asyncio.run(main())
