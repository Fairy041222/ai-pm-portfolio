"""SQLite 轻量迁移：为 models 表补充新字段并回填旧数据。"""

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from app.config import get_settings
from app.services.spark_model import normalize_spark_model


async def _migrate_invalid_model_identifiers(engine: AsyncEngine) -> None:
    """修正 model_identifier 为 default 或空的记录。"""
    from app.services.endpoint_inference import infer_vendor_from_text
    from app.services.model_runtime import resolve_api_model

    async with engine.begin() as conn:
        meta = await conn.execute(
            text("SELECT value FROM app_meta WHERE key = 'api_model_migrated_v2'")
        )
        row = meta.first()
        if row and row[0] == "1":
            return

    async with engine.begin() as conn:
        result = await conn.execute(
            text(
                """
                SELECT id, name, api_endpoint, model_identifier
                FROM models
                WHERE model_identifier IS NULL
                   OR model_identifier = ''
                   OR LOWER(model_identifier) = 'default'
                """
            )
        )
        rows = result.fetchall()

    if not rows:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT OR REPLACE INTO app_meta (key, value) "
                    "VALUES ('api_model_migrated_v2', '1')"
                )
            )
        return

    async with engine.begin() as conn:
        for row_id, name, endpoint, model_identifier in rows:
            vendor = infer_vendor_from_text(endpoint or "", name or "")
            resolved = resolve_api_model(
                vendor,
                None,
                name=name or "",
                url=endpoint or "",
            )
            if not resolved:
                continue
            await conn.execute(
                text("UPDATE models SET model_identifier = :mid WHERE id = :id"),
                {"mid": resolved, "id": row_id},
            )
            print(f"[db_migrate] api_model: {name!r} {model_identifier!r} -> {resolved!r}")

        await conn.execute(
            text(
                "INSERT OR REPLACE INTO app_meta (key, value) "
                "VALUES ('api_model_migrated_v2', '1')"
            )
        )


async def _migrate_spark_model_identifiers(engine: AsyncEngine) -> None:
    """一次性修正讯飞 Spark 模型 model_identifier=default 的记录。"""
    async with engine.begin() as conn:
        meta = await conn.execute(
            text("SELECT value FROM app_meta WHERE key = 'spark_model_migrated_v1'")
        )
        row = meta.first()
        if row and row[0] == "1":
            return

    async with engine.begin() as conn:
        result = await conn.execute(
            text(
                """
                SELECT id, name, api_endpoint, model_identifier
                FROM models
                WHERE api_endpoint LIKE '%xf-yun%'
                   OR api_endpoint LIKE '%spark-api%'
                   OR name LIKE '%Spark%'
                   OR name LIKE '%讯飞%'
                """
            )
        )
        rows = result.fetchall()

    if not rows:
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    "INSERT OR REPLACE INTO app_meta (key, value) "
                    "VALUES ('spark_model_migrated_v1', '1')"
                )
            )
        return

    async with engine.begin() as conn:
        for row_id, name, endpoint, model_identifier in rows:
            resolved = normalize_spark_model(
                model_identifier or "default",
                name or "",
                endpoint or "",
            )
            await conn.execute(
                text(
                    "UPDATE models SET model_identifier = :mid, provider_type = 'openai_compatible' "
                    "WHERE id = :id"
                ),
                {"mid": resolved, "id": row_id},
            )
            print(f"[db_migrate] 讯飞 Spark model_identifier: {name!r} -> {resolved!r}")

        await conn.execute(
            text(
                "INSERT OR REPLACE INTO app_meta (key, value) "
                "VALUES ('spark_model_migrated_v1', '1')"
            )
        )


async def migrate_models_table(engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        result = await conn.execute(text("PRAGMA table_info(models)"))
        columns = {row[1] for row in result.fetchall()}

        if "provider_type" not in columns:
            await conn.execute(
                text("ALTER TABLE models ADD COLUMN provider_type VARCHAR(32) DEFAULT 'openai_compatible'")
            )
        if "model_identifier" not in columns:
            await conn.execute(
                text("ALTER TABLE models ADD COLUMN model_identifier VARCHAR(128) DEFAULT ''")
            )
        if "custom_request_template" not in columns:
            await conn.execute(
                text("ALTER TABLE models ADD COLUMN custom_request_template TEXT")
            )

        # 旧 preset / provider 字段迁移
        await conn.execute(
            text(
                """
                UPDATE models SET provider_type = 'dashscope'
                WHERE (provider_type IS NULL OR provider_type = '' OR provider_type = 'openai_compatible')
                  AND (provider = 'qwen' OR api_endpoint LIKE '%dashscope%' OR api_endpoint LIKE '%aliyuncs%')
                """
            )
        )
        await conn.execute(
            text(
                """
                UPDATE models SET provider_type = 'openai_compatible'
                WHERE provider_type IS NULL OR provider_type = ''
                """
            )
        )
        await conn.execute(
            text(
                """
                UPDATE models SET model_identifier = name
                WHERE model_identifier IS NULL OR model_identifier = ''
                """
            )
        )
        await conn.execute(
            text(
                """
                UPDATE models SET model_identifier = 'deepseek-chat'
                WHERE name LIKE '%Deepseek%' AND (model_identifier = name OR model_identifier = '')
                """
            )
        )
        await conn.execute(
            text(
                """
                UPDATE models SET model_identifier = 'qwen-plus'
                WHERE name LIKE '%Qwen%' AND (model_identifier = name OR model_identifier = '')
                """
            )
        )
        await conn.execute(
            text(
                """
                UPDATE models SET model_identifier = 'composer-2'
                WHERE name LIKE '%Cursor%' AND (model_identifier IN ('gpt-4o', name) OR model_identifier = '')
                """
            )
        )
        # 修正误标为 custom 的 Deepseek / Cursor
        await conn.execute(
            text(
                """
                UPDATE models SET provider_type = 'openai_compatible', custom_request_template = NULL
                WHERE provider_type = 'custom'
                  AND (api_endpoint LIKE '%deepseek%' OR name LIKE '%Deepseek%')
                """
            )
        )
        await conn.execute(
            text(
                """
                UPDATE models SET provider_type = 'openai_compatible'
                WHERE name LIKE '%Cursor%' OR api_endpoint LIKE '%cursor%'
                """
            )
        )

    await _migrate_spark_model_identifiers(engine)
    await _migrate_invalid_model_identifiers(engine)

    # 以下迁移仅执行一次，避免每次启动覆盖用户已保存的 endpoint / model_identifier
    async with engine.begin() as conn:
        meta = await conn.execute(
            text("SELECT value FROM app_meta WHERE key = 'endpoint_proxy_migrated'")
        )
        row = meta.first()
        if row and row[0] == "1":
            return

    settings = get_settings()
    proxy = (settings.cursor_base_url or "").strip()
    if proxy and "api.cursor.com" not in proxy.lower():
        async with engine.begin() as conn:
            await conn.execute(
                text(
                    """
                    UPDATE models SET api_endpoint = :proxy
                    WHERE name LIKE '%Cursor%'
                      AND (api_endpoint LIKE '%api.cursor.com%' OR api_endpoint LIKE '%api.openai.com%')
                    """
                ),
                {"proxy": proxy.rstrip("/")},
            )
            await conn.execute(
                text(
                    "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('endpoint_proxy_migrated', '1')"
                )
            )
