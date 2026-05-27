"""根据用户勾选的 model_ids 解析参与对话/评测的模型记录。"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ModelORM

MIN_REPORT_MODELS = 2


async def load_all_models(db: AsyncSession) -> list[ModelORM]:
    result = await db.execute(
        select(ModelORM).order_by(ModelORM.is_recommended.desc(), ModelORM.created_at)
    )
    return list(result.scalars().all())


def _default_pick(all_models: list[ModelORM]) -> ModelORM | None:
    if not all_models:
        return None
    for m in all_models:
        if m.is_recommended:
            return m
    return all_models[0]


async def resolve_model_ids(
    db: AsyncSession,
    model_ids: list[str] | None,
    *,
    is_report_mode: bool,
) -> tuple[list[str], list[ModelORM], bool, str]:
    """
    返回 (resolved_ids, model_records, used_default, primary_display_name)。
    used_default：用户未勾选任何有效模型时为 True。
    """
    requested = [mid for mid in (model_ids or []) if mid]
    all_models = await load_all_models(db)
    by_id = {m.id: m for m in all_models}

    records: list[ModelORM] = []
    for mid in requested:
        if mid in by_id and not any(r.id == mid for r in records):
            records.append(by_id[mid])

    missing_ids = [mid for mid in requested if mid not in by_id]
    if missing_ids:
        print(f"[model_resolver] 警告: 以下 model_id 不存在，已跳过: {missing_ids}")

    used_default = len(requested) == 0

    if is_report_mode:
        if len(records) < MIN_REPORT_MODELS:
            seen = {r.id for r in records}
            for m in all_models:
                if m.id not in seen:
                    records.append(m)
                    seen.add(m.id)
                if len(records) >= MIN_REPORT_MODELS:
                    break
        if records:
            print(
                f"[model_resolver] 报告模式模型({len(records)}个): "
                f"{[m.name for m in records]} (请求={len(requested)} auto={used_default})"
            )
            return ([m.id for m in records], records, used_default, records[0].name)
        print("[model_resolver] 报告模式：库中无模型")
        return ([], [], True, "")

    if records:
        print(f"[model_resolver] 普通对话模型: {records[0].name} (auto={used_default})")
        return ([records[0].id], [records[0]], used_default, records[0].name)

    fallback = _default_pick(all_models)
    if fallback:
        print(f"[model_resolver] 普通对话自动选用: {fallback.name}")
        return ([fallback.id], [fallback], True, fallback.name)

    print("[model_resolver] 无可用模型")
    return ([], [], True, "")
