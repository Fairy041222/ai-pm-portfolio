from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import ModelORM
from app.schemas import CreateModelRequest, ModelRegistrySchema, ModelSchema, UpdateModelRequest
from app.services.model_registry import build_registry_payload
from app.services.endpoint_inference import parse_endpoint
from app.services.model_runtime import resolve_api_model
from app.services.security_service import log_api_key_upload_rejected

router = APIRouter(prefix="/api/models", tags=["models"])


def _reject_api_key_in_body(
    body: CreateModelRequest | UpdateModelRequest,
    session_id: str | None = None,
) -> None:
    if isinstance(body, CreateModelRequest):
        if (body.api_key or "").strip():
            log_api_key_upload_rejected(session_id, endpoint="POST /api/models")
            raise HTTPException(
                status_code=400,
                detail="API Key 仅允许保存在浏览器本地，请勿上传到服务器",
            )
        return
    if body.api_key and body.api_key.strip():
        log_api_key_upload_rejected(session_id, endpoint="PUT /api/models")
        raise HTTPException(
            status_code=400,
            detail="API Key 仅允许保存在浏览器本地，请勿上传到服务器",
        )
    if body.clear_api_key:
        log_api_key_upload_rejected(session_id, endpoint="PUT /api/models/clear")
        raise HTTPException(
            status_code=400,
            detail="API Key 由浏览器本地管理，服务端不存储 Key",
        )


def _resolve_api_endpoint(body: CreateModelRequest | UpdateModelRequest) -> str | None:
    if isinstance(body, CreateModelRequest):
        return (body.api_endpoint or body.api or "").strip()
    if body.api_endpoint is not None:
        return body.api_endpoint.strip()
    if body.api is not None:
        return body.api.strip()
    return None


def _resolve_api_model(body: CreateModelRequest | UpdateModelRequest) -> str | None:
    if isinstance(body, CreateModelRequest):
        return (body.api_model or "").strip() or None
    if body.api_model is not None:
        return body.api_model.strip() or None
    return None


def _orm_to_schema(m: ModelORM) -> ModelSchema:
    return ModelSchema(
        id=m.id,
        name=m.name,
        api_endpoint=m.api_endpoint or "",
        api_model=m.model_identifier or "",
        has_api_key=False,
        api_key_masked=None,
        is_recommended=m.is_recommended,
    )


def _normalize_raw_endpoint(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return s
    if not s.startswith(("http://", "https://")):
        s = f"https://{s}"
    return s


def _apply_parsed(
    model: ModelORM,
    parsed,
    *,
    raw_endpoint: str | None = None,
    user_api_model: str | None = None,
) -> None:
    if raw_endpoint is not None:
        model.api_endpoint = _normalize_raw_endpoint(raw_endpoint)
    model.provider_type = parsed.provider_type
    model.provider = parsed.provider_type
    model.custom_request_template = None
    model.api_key_encrypted = None

    resolved = resolve_api_model(
        parsed.vendor,
        user_api_model or parsed.model_identifier,
        name=model.name,
        url=model.api_endpoint,
    )
    if not resolved:
        raise HTTPException(
            status_code=400,
            detail="无法推断 API model 名称，请填写 model 字段（如 hy3-preview、lite、deepseek-chat）",
        )
    model.model_identifier = resolved


@router.get("/registry", response_model=ModelRegistrySchema)
async def get_model_registry() -> ModelRegistrySchema:
    """读取 config/models.yaml，供前端动态加载预设模型与厂商适配器。"""
    payload = build_registry_payload()
    return ModelRegistrySchema.model_validate(payload)


@router.get("", response_model=list[ModelSchema])
async def list_models(db: AsyncSession = Depends(get_db)) -> list[ModelSchema]:
    result = await db.execute(
        select(ModelORM).order_by(ModelORM.is_recommended.desc(), ModelORM.name)
    )
    return [_orm_to_schema(m) for m in result.scalars().all()]


@router.post("", response_model=ModelSchema, status_code=201)
async def create_model(
    body: CreateModelRequest,
    db: AsyncSession = Depends(get_db),
) -> ModelSchema:
    _reject_api_key_in_body(body)
    name = body.name.strip()
    raw_endpoint = _resolve_api_endpoint(body)
    user_api_model = _resolve_api_model(body)
    if not name or not raw_endpoint:
        raise HTTPException(status_code=400, detail="name 与 api_endpoint 不能为空")

    try:
        parsed = parse_endpoint(raw_endpoint, name, user_api_model=user_api_model or "")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    model = ModelORM(
        id=new_id("model_"),
        name=name,
        is_recommended=False,
        is_custom=True,
        api_key_encrypted=None,
    )
    try:
        _apply_parsed(
            model,
            parsed,
            raw_endpoint=raw_endpoint,
            user_api_model=user_api_model,
        )
    except HTTPException:
        raise
    db.add(model)
    await db.flush()
    print(
        f"[API] 添加模型: {name} vendor={parsed.vendor} "
        f"endpoint={model.api_endpoint} api_model={model.model_identifier}"
    )
    return _orm_to_schema(model)


@router.get("/{model_id}", response_model=ModelSchema)
async def get_model(
    model_id: str,
    db: AsyncSession = Depends(get_db),
) -> ModelSchema:
    result = await db.execute(select(ModelORM).where(ModelORM.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    return _orm_to_schema(model)


@router.put("/{model_id}", response_model=ModelSchema)
async def update_model(
    model_id: str,
    body: UpdateModelRequest,
    db: AsyncSession = Depends(get_db),
) -> ModelSchema:
    _reject_api_key_in_body(body)
    result = await db.execute(select(ModelORM).where(ModelORM.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")

    user_api_model = _resolve_api_model(body)

    if body.name is not None:
        model.name = body.name.strip()

    raw_endpoint = _resolve_api_endpoint(body)
    if raw_endpoint:
        try:
            parsed = parse_endpoint(
                raw_endpoint,
                model.name,
                user_api_model=user_api_model or model.model_identifier or "",
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            _apply_parsed(
                model,
                parsed,
                raw_endpoint=raw_endpoint,
                user_api_model=user_api_model,
            )
        except HTTPException:
            raise
    elif user_api_model is not None:
        from app.services.endpoint_inference import infer_vendor_from_text

        vendor = infer_vendor_from_text(model.api_endpoint or "", model.name or "")
        resolved = resolve_api_model(
            vendor,
            user_api_model,
            name=model.name,
            url=model.api_endpoint,
        )
        if not resolved:
            raise HTTPException(status_code=400, detail="api_model 不能为空或 default")
        model.model_identifier = resolved

    model.api_key_encrypted = None
    await db.flush()
    return _orm_to_schema(model)


@router.post("/{model_id}/set-default", response_model=ModelSchema)
async def set_default_model(
    model_id: str,
    db: AsyncSession = Depends(get_db),
) -> ModelSchema:
    result = await db.execute(select(ModelORM).where(ModelORM.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")

    await db.execute(update(ModelORM).values(is_recommended=False))
    model.is_recommended = True
    await db.flush()
    return _orm_to_schema(model)


@router.delete("/{model_id}", status_code=204)
async def delete_model(
    model_id: str,
    db: AsyncSession = Depends(get_db),
) -> None:
    result = await db.execute(select(ModelORM).where(ModelORM.id == model_id))
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    await db.execute(delete(ModelORM).where(ModelORM.id == model_id))
    await db.flush()
