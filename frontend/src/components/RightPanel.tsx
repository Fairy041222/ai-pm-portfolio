import { useEffect, useState } from 'react';
import { Plus, X, Star, Check, Trash2, Pencil } from 'lucide-react';
import { useApp } from '@/context/AppContext';
import { USE_MOCK_API } from '@/config/env';
import * as api from '@/api/client';
import type { Model, ModelFormValues } from '@/types';
import {
  listEnabledPresets,
  setModelRegistry,
} from '@/services/modelRegistryCache';
import { mergeModelWithLocalKey, resolveModelApiKey } from '@/services/modelKeyStorage';
import { inferVendorFromEndpoint } from '@/utils/vendorInference';

interface RightPanelProps {
  modelError?: string;
}

const EMPTY_FORM: ModelFormValues = {
  name: '',
  apiEndpoint: '',
  apiModel: '',
  apiKey: '',
};

function truncateEndpoint(url: string, max = 28): string {
  if (!url) return '';
  if (url.length <= max) return url;
  return `${url.slice(0, max)}…`;
}

export default function RightPanel({ modelError }: RightPanelProps) {
  const { state, dispatch, createModel, updateModel, setDefaultModel, deleteModelsByIds } =
    useApp();
  const [formMode, setFormMode] = useState<'add' | 'edit' | null>(null);
  const [editingModel, setEditingModel] = useState<Model | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [loadingEditId, setLoadingEditId] = useState<string | null>(null);
  const [, setRegistryTick] = useState(0);

  useEffect(() => {
    if (listEnabledPresets().length > 0) return;
    void api.fetchModelRegistry()
      .then((registry) => {
        setModelRegistry(registry);
        setRegistryTick((n) => n + 1);
      })
      .catch(() => {});
  }, []);

  const canOpenDelete = state.models.length > 0;

  const toggleModel = (id: string) => {
    dispatch({ type: 'TOGGLE_MODEL', id });
  };

  const openAdd = () => {
    setEditingModel(null);
    setFormMode('add');
  };

  const openEdit = async (model: Model, e: React.MouseEvent) => {
    e.stopPropagation();
    setLoadingEditId(model.id);
    try {
      const fresh = USE_MOCK_API
        ? state.models.find((m) => m.id === model.id) ?? model
        : mergeModelWithLocalKey(await api.fetchModel(model.id));
      console.log('[RightPanel] 打开编辑，从后端拉取模型详情', fresh);
      setEditingModel(fresh);
      setFormMode('edit');
    } catch (err) {
      console.error('[RightPanel] 获取模型详情失败', err);
      window.alert(err instanceof Error ? err.message : '获取模型详情失败');
    } finally {
      setLoadingEditId(null);
    }
  };

  const handleSetDefault = (model: Model, e: React.MouseEvent) => {
    e.stopPropagation();
    void setDefaultModel(model.id);
  };

  return (
    <>
      <aside
        className="flex flex-col h-full border-l border-(--color-border)"
        style={{ width: 280, backgroundColor: 'var(--color-right-bg)' }}
      >
        <div className="px-4 pt-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-(--color-text-primary) shrink-0">
              模型选择
            </h3>
            <button
              type="button"
              title={canOpenDelete ? '删除模型' : '暂无模型可删除'}
              disabled={!canOpenDelete}
              onClick={() => setShowDeleteModal(true)}
              className="shrink-0 p-1.5 rounded-lg text-(--color-text-secondary) hover:text-(--color-error) hover:bg-red-50 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 size={18} />
            </button>
          </div>
          <p className="text-xs text-(--color-text-secondary) mt-0.5">
            请选择对应的模型来进行测试
          </p>
        </div>

        {modelError && (
          <div className="mx-3 mt-3 px-3 py-2 rounded-lg bg-red-50 border border-(--color-error)/30 text-xs text-(--color-error) font-medium">
            {modelError}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-3 pb-3 pt-0">
          {state.models.length === 0 && (
            <div className="px-3 py-6 text-center">
              <p className="text-sm text-(--color-text-secondary) leading-relaxed">
                暂无模型，请点击下方添加
              </p>
            </div>
          )}
          {state.models.map((model) => {
            const isSelected = state.selectedModelIds.includes(model.id);
            return (
              <div
                key={model.id}
                className="relative w-full flex items-center gap-1 px-3 py-3 rounded-xl mb-2 border transition-all"
                style={{
                  borderColor: isSelected ? 'var(--color-primary)' : 'var(--color-border)',
                  backgroundColor: isSelected ? '#EEF2FF' : 'white',
                }}
              >
                <button
                  type="button"
                  onClick={() => toggleModel(model.id)}
                  className="flex flex-1 items-center gap-3 min-w-0 text-left cursor-pointer"
                >
                  <div
                    className="w-4 h-4 rounded shrink-0 flex items-center justify-center"
                    style={{
                      backgroundColor: isSelected ? 'var(--color-primary)' : 'white',
                      border: isSelected ? 'none' : '1.5px solid var(--color-border)',
                    }}
                  >
                    {isSelected && <Check size={10} color="white" strokeWidth={3} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-(--color-text-primary) truncate">
                        {model.name}
                      </span>
                      {model.isRecommended && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-amber-50 text-amber-700 shrink-0">
                          默认
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-(--color-text-secondary) mt-0.5 truncate">
                      {model.apiModel ? `${model.apiModel} · ` : ''}
                      {truncateEndpoint(model.apiEndpoint)}
                      {!model.hasApiKey && ' · 未配置 Key'}
                    </p>
                  </div>
                </button>
                {!model.isRecommended && (
                  <button
                    type="button"
                    title="设为默认"
                    onClick={(e) => handleSetDefault(model, e)}
                    className="shrink-0 p-1 rounded-md text-(--color-text-secondary) hover:text-(--color-warning) hover:bg-amber-50 cursor-pointer"
                  >
                    <Star size={14} />
                  </button>
                )}
                <button
                  type="button"
                  title="编辑模型"
                  disabled={loadingEditId === model.id}
                  onClick={(e) => void openEdit(model, e)}
                  className="shrink-0 p-1 rounded-md text-(--color-text-secondary) hover:text-(--color-primary) hover:bg-(--color-primary)/10 cursor-pointer disabled:opacity-50"
                >
                  <Pencil size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="px-4 py-2 text-xs text-(--color-text-secondary)">
          已选{' '}
          <span className="font-semibold text-(--color-primary)">
            {state.selectedModelIds.length}
          </span>{' '}
          个模型
        </div>

        <div className="p-3">
          <button
            type="button"
            onClick={openAdd}
            className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border border-dashed border-(--color-primary)/40 text-sm text-(--color-primary) hover:bg-(--color-primary)/5 transition-colors cursor-pointer"
          >
            <Plus size={15} />
            添加模型
          </button>
        </div>
      </aside>

      {formMode && (
        <ModelFormDialog
          mode={formMode}
          initial={editingModel}
          onClose={() => {
            setFormMode(null);
            setEditingModel(null);
          }}
          onSubmit={async (values, keyMeta) => {
            if (formMode === 'add') {
              console.log('[RightPanel] 提交添加模型', values);
              await createModel(values);
            } else if (editingModel) {
              const patch: Partial<ModelFormValues> = {
                name: values.name,
                apiEndpoint: values.apiEndpoint,
                apiModel: values.apiModel,
              };
              if (keyMeta.keyDirty) {
                patch.apiKey = values.apiKey;
              }
              console.log('[RightPanel] 提交编辑模型', {
                modelId: editingModel.id,
                patch,
                keyDirty: keyMeta.keyDirty,
              });
              const updated = await updateModel(editingModel.id, patch, {
                hadKey: Boolean(resolveModelApiKey(editingModel)),
                userClearedKey:
                  keyMeta.keyDirty &&
                  !values.apiKey.trim() &&
                  Boolean(resolveModelApiKey(editingModel)),
              });
              console.log('[RightPanel] 保存完成，服务端返回', updated);
            }
            setFormMode(null);
            setEditingModel(null);
          }}
        />
      )}

      {showDeleteModal && (
        <DeleteModelsModal
          models={state.models}
          isDeleting={isDeleting}
          onClose={() => setShowDeleteModal(false)}
          onConfirmDelete={async (ids) => {
            if (!ids.length) return;
            setIsDeleting(true);
            try {
              await deleteModelsByIds(ids);
              setShowDeleteModal(false);
            } catch (err) {
              const message =
                err instanceof Error ? err.message : '删除失败，请稍后重试';
              window.alert(message);
            } finally {
              setIsDeleting(false);
            }
          }}
        />
      )}
    </>
  );
}

function DeleteModelsModal({
  models,
  isDeleting,
  onClose,
  onConfirmDelete,
}: {
  models: Model[];
  isDeleting: boolean;
  onClose: () => void;
  onConfirmDelete: (ids: string[]) => Promise<void>;
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setSelectedIds(new Set());
  }, [models]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-[400px] max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-(--color-border) shrink-0">
          <h2 className="text-base font-semibold text-(--color-text-primary)">删除模型</h2>
          <button type="button" onClick={onClose} disabled={isDeleting} className="cursor-pointer">
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-4 overflow-y-auto flex-1">
          <p className="text-sm text-(--color-text-secondary) mb-3">
            勾选要删除的模型，确认后永久移除。
          </p>
          <ul className="space-y-2">
            {models.map((model) => (
              <li
                key={model.id}
                className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-(--color-border)"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(model.id)}
                  disabled={isDeleting}
                  onChange={() => toggleSelect(model.id)}
                  className="w-4 h-4 accent-(--color-primary) cursor-pointer"
                />
                <span className="text-sm font-medium truncate">{model.name}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex gap-3 px-6 py-4 border-t shrink-0">
          <button type="button" onClick={onClose} disabled={isDeleting} className="flex-1 px-4 py-2 rounded-lg border text-sm cursor-pointer">
            取消
          </button>
          <button
            type="button"
            onClick={() => void onConfirmDelete([...selectedIds])}
            disabled={isDeleting || selectedIds.size === 0}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white bg-(--color-error) cursor-pointer disabled:opacity-50"
          >
            {isDeleting ? '删除中…' : `确认删除 (${selectedIds.size})`}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModelFormDialog({
  mode,
  initial,
  onClose,
  onSubmit,
}: {
  mode: 'add' | 'edit';
  initial: Model | null;
  onClose: () => void;
  onSubmit: (
    values: ModelFormValues,
    keyMeta: { keyDirty: boolean },
  ) => Promise<void>;
}) {
  const displayKeyForEdit =
    initial?.hasApiKey ? (initial.apiKeyMasked ?? '••••••••') : '';

  const [values, setValues] = useState<ModelFormValues>(() =>
    initial
      ? {
          name: initial.name,
          apiEndpoint: initial.apiEndpoint,
          apiModel: initial.apiModel ?? '',
          apiKey: displayKeyForEdit,
        }
      : { ...EMPTY_FORM },
  );
  const [keyDirty, setKeyDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const vendorHint = inferVendorFromEndpoint(values.apiEndpoint, values.name);

  useEffect(() => {
    if (!initial) {
      setValues({ ...EMPTY_FORM });
      setKeyDirty(false);
      return;
    }
    const displayKey = initial.hasApiKey ? (initial.apiKeyMasked ?? '••••••••') : '';
    setValues({
      name: initial.name,
      apiEndpoint: initial.apiEndpoint,
      apiModel: initial.apiModel ?? '',
      apiKey: displayKey,
    });
    setKeyDirty(false);
    console.log('[ModelFormDialog] 表单已同步模型详情', {
      id: initial.id,
      name: initial.name,
      apiEndpoint: initial.apiEndpoint,
      apiModel: initial.apiModel,
    });
  }, [initial?.id, mode]);

  const canSubmit =
    values.name.trim() &&
    values.apiEndpoint.trim() &&
    (mode === 'add' ? values.apiKey.trim() && !values.apiKey.includes('*') : true);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await onSubmit(
        {
          name: values.name.trim(),
          apiEndpoint: values.apiEndpoint.trim(),
          apiModel: values.apiModel.trim(),
          apiKey: values.apiKey,
        },
        { keyDirty },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-[420px]">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-base font-semibold">
            {mode === 'add' ? '添加模型' : '编辑模型'}
          </h2>
          <button type="button" onClick={onClose} className="cursor-pointer">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <Field label="模型名称">
            <input
              type="text"
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder="例：我的 Deepseek"
              className="field-input"
            />
          </Field>

          <Field label="API Model">
            <input
              type="text"
              value={values.apiModel}
              onChange={(e) => setValues((v) => ({ ...v, apiModel: e.target.value }))}
              placeholder="hy3-preview / lite / deepseek-chat / qwen-plus"
              className="field-input"
            />
            <p className="text-xs text-(--color-text-secondary) mt-1">
              厂商 API 请求体中的 model 值；留空则按名称自动推断（Hy3→hy3-preview，Spark Lite→lite）
            </p>
          </Field>

          <Field label="API 地址">
            <input
              type="text"
              value={values.apiEndpoint}
              onChange={(e) => setValues((v) => ({ ...v, apiEndpoint: e.target.value }))}
              placeholder="https://api.deepseek.com/v1 或讯飞 https://spark-api-open.xf-yun.com/v1/chat/completions"
              className="field-input"
            />
            <p className="text-xs text-(--color-text-secondary) mt-1">
              可填完整 chat 地址或 base URL
            </p>
          </Field>

          <Field
            label={
              mode === 'edit' && initial?.hasApiKey && !keyDirty
                ? 'API Key（已保存在浏览器，修改请重新输入）'
                : mode === 'edit' && keyDirty && !values.apiKey.trim()
                  ? 'API Key（留空将删除本地 Key）'
                  : 'API Key（仅保存在浏览器，不上传服务器）'
            }
          >
            <input
              type="password"
              value={values.apiKey}
              onChange={(e) => {
                setKeyDirty(true);
                setValues((v) => ({ ...v, apiKey: e.target.value }));
              }}
              placeholder={
                vendorHint === 'spark'
                  ? '讯飞 HTTP 接口 APIPassword'
                  : mode === 'add'
                    ? 'sk-...'
                    : initial?.hasApiKey
                      ? '已保存的 Key'
                      : 'sk-...'
              }
              autoComplete="off"
              className="field-input"
            />
            {vendorHint === 'spark' && (
              <p className="text-xs text-(--color-text-secondary) mt-1">
                请填写讯飞控制台 Spark Lite「HTTP 服务接口认证信息」中的 APIPassword（Bearer 鉴权）。
                勿填写 WebSocket 的 APIKey:APISecret。API 地址：https://spark-api-open.xf-yun.com/v1
              </p>
            )}
          </Field>
        </div>

        <div className="flex gap-3 px-6 py-4 border-t">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 rounded-lg border text-sm cursor-pointer"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit || saving}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white cursor-pointer disabled:opacity-50"
            style={{
              backgroundColor: canSubmit ? 'var(--color-primary)' : '#D1D5DB',
            }}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>

      <style>{`
        .field-input {
          width: 100%;
          padding: 0.625rem 0.75rem;
          border-radius: 0.5rem;
          border: 1px solid var(--color-border);
          font-size: 0.875rem;
          outline: none;
        }
        .field-input:focus {
          border-color: var(--color-primary);
          box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 20%, transparent);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium mb-1.5">{label}</label>
      {children}
    </div>
  );
}
