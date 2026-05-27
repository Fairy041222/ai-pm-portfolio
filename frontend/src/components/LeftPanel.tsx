import { useState, useRef, useMemo } from 'react';
import { useApp } from '@/context/AppContext';
import type { Conversation } from '@/types';
import {
  filterHistoryConversations,
  sortConversationsByRecency,
} from '@/utils/conversationUtils';
// Logo SVG 引入（vite-plugin-svgr）

function LogoTitle() {
  const [loadError, setLoadError] = useState(false);

  // 尝试用 SVG，失败 fallback 到 emoji
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '20px 16px',
        boxSizing: 'border-box',
        userSelect: 'none'
      }}
    >
      {loadError ? (
        <span
          style={{
            width: 28,
            height: 28,
            fontSize: 28,
            lineHeight: '28px',
            display: 'inline-flex',
            alignItems: 'center',
            marginRight: 10
          }}
        >
          🤖
        </span>
      ) : (
        <span
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            marginRight: 5
          }}
        >
          {/* Try to render SVG, fallback on error */}
          <img
            src="/src/assets/icon/AIPM_Bench_icon.svg"
            alt="AIPM Bench Logo"
            width={28}
            height={28}
            style={{
              display: 'block',
              marginRight: 10
            }}
            onError={() => setLoadError(true)}
          />
        </span>
      )}
      <span
        style={{
          fontSize: 20,
          fontWeight: 600,
          color: '#111827',
          lineHeight: 1
        }}
      >
        AIPM Bench
      </span>
    </div>
  );
}

export default function LeftPanel() {
  const { state, dispatch, createNewConversation, deleteConversationsByIds } = useApp();
  const historyConversations = useMemo(
    () =>
      sortConversationsByRecency(filterHistoryConversations(state.conversations)),
    [state.conversations],
  );
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [toDelete, setToDelete] = useState<string[]>([]);
  const [showDeleteTooltip, setShowDeleteTooltip] = useState(false);

  // 钩子确保关闭弹窗时重新 focus 到删除按钮
  const deleteBtnRef = useRef<HTMLButtonElement>(null);

  // 新建对话
  const handleNewConversation = () => {
    void createNewConversation();
  };

  const handleSelectConv = (id: string) => {
    dispatch({ type: 'SET_ACTIVE_CONVERSATION', id });
  };

  // 打开删除弹窗
  const openDeleteModal = () => {
    setToDelete([]);
    setShowDeleteModal(true);
    setShowDeleteTooltip(false);
  };

  // 删除切换
  const toggleDelete = (id: string) => {
    if (id === '_ALL_CLEAR_') {
      setToDelete([]);
      return;
    }
    setToDelete(prev =>
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  // 确认删除，自动切换激活对话（如被删除则切第一个剩余）
  const confirmDelete = () => {
    void deleteConversationsByIds(toDelete).then(() => {
      setShowDeleteModal(false);
      setToDelete([]);
    });
  };

  return (
    <>
      <aside
        style={{
          width: 260,
          height: '100%',
          minHeight: 0,
          background: '#F5F5F5',
          borderRight: '1px solid #E5E5E5',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* 头部：Logo + 新建对话 + 标题（不滚动） */}
        <div style={{ flexShrink: 0 }}>
          <LogoTitle />
          <div style={{ padding: '8px 16px 0 16px' }}>
            <button
              onClick={handleNewConversation}
              style={{
                width: '100%',
                background: '#2962EF',
                border: '1px solid #2962EF',
                borderRadius: 8,
                padding: '10px 16px',
                fontWeight: 500,
                color: '#fff',
                fontSize: 14,
                letterSpacing: '0.5px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 0,
                transition: 'background 0.15s',
                cursor: 'pointer',
                userSelect: 'none',
              }}
              onMouseOver={(e) => {
                e.currentTarget.style.background = '#2256D5';
              }}
              onMouseOut={(e) => {
                e.currentTarget.style.background = '#2962EF';
              }}
              tabIndex={0}
            >
              + 新建对话
            </button>
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: '#6B7280',
              padding: '12px 16px 6px 16px',
              margin: 0,
              letterSpacing: 0,
            }}
          >
            历史对话
          </div>
        </div>

        {/* 对话列表：占满剩余高度并可滚动 */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
          }}
          className="scrollbar-none"
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {historyConversations.map((conv, idx) => (
              <ConversationItem
                key={conv.id}
                conv={conv}
                isActive={conv.id === state.activeConversationId}
                onClick={() => handleSelectConv(conv.id)}
                isLast={idx === historyConversations.length - 1}
                badge={conv.relatedReportId ? '报告' : undefined}
              />
            ))}
          </div>
        </div>

        {/* 底部：垃圾桶固定可见，不随列表滚动 */}
        <div
          style={{
            flexShrink: 0,
            background: '#F5F5F5',
            padding: '15px 16px',
            position: 'relative',
          }}
        >
          <button
            ref={deleteBtnRef}
            onClick={openDeleteModal}
            aria-label="删除对话"
            type="button"
            style={{
              border: 'none',
              background: 'none',
              padding: 0,
              cursor: 'pointer',
              outline: 'none',
              width: 26,
              height: 26,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'flex-start',
              position: 'relative',
            }}
            onMouseOver={() => setShowDeleteTooltip(true)}
            onMouseOut={() => setShowDeleteTooltip(false)}
            tabIndex={0}
          >
            <span
              style={{
                fontSize: 20,
                color: showDeleteTooltip ? '#EF4444' : '#9CA3AF',
                transition: 'color 0.15s',
                display: 'block',
                lineHeight: 1,
                width: 25,
                height: 43,
              }}
            >
              <img
                src="/src/assets/icon/AIPM_Bench_icon_4.svg"
                alt="删除对话"
                className="w-10 h-10"
              />
            </span>
            {showDeleteTooltip && (
              <span
                style={{
                  position: 'absolute',
                  left: 30,
                  bottom: '0%',
                  whiteSpace: 'nowrap',
                  fontSize: 13,
                  padding: '5px 12px',
                  background: '#111827de',
                  borderRadius: 6,
                  color: '#fff',
                  marginLeft: 12,
                  zIndex: 10,
                  boxShadow: '0 2px 8px rgba(0,0,0,0.16)',
                }}
              >
                删除对话
              </span>
            )}
          </button>
        </div>
      </aside>

      {/* Delete Modal */}
      {showDeleteModal && (
        <DeleteDialog
          conversations={historyConversations}
          selected={toDelete}
          onToggle={toggleDelete}
          onConfirm={confirmDelete}
          onClose={() => {
            setShowDeleteModal(false);
            setTimeout(() => {
              deleteBtnRef.current?.focus();
            }, 0);
          }}
        />
      )}

      {/* Custom scrollbar for conversation list */}
      <style>{`
        .scrollbar-thin::-webkit-scrollbar {
          width: 6px;
        }
        .scrollbar-thin::-webkit-scrollbar-thumb {
          background: #E5E5E5;
          border-radius: 6px;
        }
        .scrollbar-thin::-webkit-scrollbar-track {
          background: transparent;
        }
        .delete-checkbox {
          width: 18px !important; height: 18px !important; border-radius: 4px !important;
        }
      `}</style>
    </>
  );
}

function formatDate(dateString?: string) {
  if (!dateString) return '';
  let d: Date;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(dateString)) {
    return dateString.slice(0, 16);
  }
  d = new Date(dateString);
  if (isNaN(d.getTime())) return dateString;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ConversationItem({
  conv,
  isActive,
  onClick,
  isLast,
  badge,
}: {
  conv: Conversation;
  isActive: boolean;
  onClick: () => void;
  isLast?: boolean;
  /** 如「报告」标签，与推荐模型标签互斥展示 */
  badge?: string;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{
        borderBottom: isLast ? 'none' : '1px solid #F0F0F0',
        background: isActive
          ? '#F2F6FE'
          : hovered
          ? '#F8F9FA'
          : 'transparent',
        borderLeft: isActive ? '3px solid #4F46E5' : '3px solid transparent',
        transition: 'background 0.15s,border-color 0.15s',
        display: 'flex',
        alignItems: 'stretch',
        padding: 0,
      }}
    >
      <button
        onClick={onClick}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          padding: '12px 16px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          color: '#111827',
          boxSizing: 'border-box',
        }}
        tabIndex={0}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            marginBottom: 0,
            minHeight: 22,
          }}
        >
          <span
            style={{
              fontWeight: 500,
              fontSize: 14,
              color: '#111827',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              flex: 1,
              lineHeight: '22px'
            }}
          >
            {conv.title}
          </span>
          {badge ? (
            <span
              style={{
                marginLeft: 10,
                background: '#EEF2FF',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 11,
                color: '#4F46E5',
                fontWeight: 500,
                lineHeight: '18px',
                flexShrink: 0,
              }}
            >
              {badge}
            </span>
          ) : (
            conv.recommendedModel && (
              <span
                style={{
                  marginLeft: 10,
                  background: '#F0F0F0',
                  borderRadius: 4,
                  padding: '2px 8px',
                  fontSize: 11,
                  color: '#6B7280',
                  fontWeight: 400,
                  lineHeight: '18px',
                  verticalAlign: 'middle',
                  maxWidth: '50%',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  flexShrink: 0,
                  marginRight: 0,
                }}
              >
                推荐：{conv.recommendedModel}
              </span>
            )
          )}
        </div>
        <div
          style={{
            fontSize: 11,
            color: '#9CA3AF',
            marginTop: 4,
            lineHeight: '15px',
          }}
        >
          {formatDate(conv.date)}
        </div>
      </button>
    </div>
  );
}

// 专用复选框
function Checkbox({
  checked,
  className = '',
}: {
  checked: boolean;
  className?: string;
}) {
  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        border: `2px solid ${checked ? '#4F46E5' : '#D1D5DB'}`,
        background: checked ? '#4F46E5' : '#FFF',
        borderRadius: 4,
        transition: 'background 0.15s, border-color 0.15s',
        boxSizing: 'border-box',
        marginRight: 12,
        flexShrink: 0,
        userSelect: 'none',
        cursor: 'pointer',
        position: 'relative'
      }}
    >
      {checked && (
        <span
          style={{
            color: '#FFF',
            fontSize: 13,
            fontWeight: 'bold',
            position: 'relative',
            left: 1,
            lineHeight: 0,
          }}
        >
          ✓
        </span>
      )}
    </span>
  );
}

function DeleteDialog({
  conversations,
  selected,
  onToggle,
  onConfirm,
  onClose,
}: {
  conversations: Conversation[];
  selected: string[];
  onToggle: (id: string) => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  // 全选
  const allSelected =
    conversations.length > 0 && selected.length === conversations.length;
  const hasSelection = selected.length > 0;

  function handleConfirmDelete() {
    if (hasSelection) onConfirm();
  }

  // 遮罩层关闭
  function handleMaskClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      onClose();
    }
  }

  // 全选切换
  function handleSelectAll() {
    if (allSelected) {
      onToggle('_ALL_CLEAR_');
    } else {
      conversations.forEach(conv => {
        if (!selected.includes(conv.id)) onToggle(conv.id);
      });
    }
  }

  return (
    <div
      style={{
        position: 'fixed',
        zIndex: 9999,
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        userSelect: 'none'
      }}
      onClick={handleMaskClick}
    >
      <div
        style={{
          width: 480,
          background: '#FFF',
          borderRadius: 16,
          boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '88vh',
          overflow: 'hidden',
          position: 'relative',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '20px 24px 0 24px',
            justifyContent: 'space-between',
            borderBottom: 'none',
          }}
        >
          <span
            style={{
              fontWeight: 600,
              fontSize: 18,
              color: '#111827',
              flex: 1,
              textAlign: 'left'
            }}
          >
            历史任务
          </span>
          <button
            onClick={handleSelectAll}
            type="button"
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              marginLeft: 18,
              fontSize: 15,
              fontWeight: 500,
              color: '#111827',
              padding: 0,
              gap: 6,
              userSelect: 'none'
            }}
            tabIndex={0}
            aria-label={allSelected ? "取消全选" : "全选"}
          >
            <Checkbox checked={allSelected} className="delete-checkbox" />
            <span style={{ fontSize: 15, color: '#111827', fontWeight: 500 }}>全选</span>
          </button>
        </div>

        {/* Conversation list */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '0px 0 0 0',
            minHeight: 60,
            maxHeight: 400,
            marginTop: 12,
            marginBottom: 0,
          }}
          className="scrollbar-thin"
        >
          {conversations.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                fontSize: 15,
                color: '#6B7280',
                margin: '40px 0',
              }}
            >
              暂无对话
            </div>
          ) : (
            <div style={{}}>
              {conversations.map((conv, idx) => {
                const checked = selected.includes(conv.id);
                const isLast = idx === conversations.length - 1;
                return (
                  <div
                    key={conv.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      borderBottom: isLast ? 'none' : '1px solid #EEEEEE',
                      background: 'transparent',
                      padding: 0,
                      minHeight: 44
                    }}
                  >
                    <button
                      type="button"
                      aria-checked={checked}
                      tabIndex={0}
                      onClick={() => onToggle(conv.id)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        padding: '12px 0 12px 24px',
                        margin: 0,
                        display: 'flex',
                        alignItems: 'flex-start',
                        cursor: 'pointer',
                        outline: 'none',
                        userSelect: 'none',
                      }}
                    >
                      <Checkbox checked={checked} className="delete-checkbox" />
                    </button>
                    <div
                      style={{
                        flex: 1,
                        minWidth: 0,
                        padding: '12px 24px 12px 0',
                        marginLeft: 0,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'center'
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          fontWeight: 500,
                          fontSize: 14,
                          color: '#111827',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                          overflow: 'hidden',
                          lineHeight: '22px',
                        }}
                      >
                        <span
                          style={{
                            flex: 1,
                            whiteSpace: 'nowrap',
                            textOverflow: 'ellipsis',
                            overflow: 'hidden'
                          }}
                        >
                          {conv.title}
                        </span>
                        {conv.recommendedModel && (
                          <span
                            style={{
                              marginLeft: 10,
                              background: '#F0F0F0',
                              borderRadius: 4,
                              padding: '2px 8px',
                              fontSize: 11,
                              color: '#6B7280',
                              fontWeight: 400,
                              lineHeight: '18px',
                              verticalAlign: 'middle',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              flexShrink: 0,
                              marginRight: 0,
                            }}
                          >
                            推荐：{conv.recommendedModel}
                          </span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 12,
                          color: '#9CA3AF',
                          marginTop: 4,
                          lineHeight: '16px',
                          whiteSpace: 'nowrap'
                        }}
                      >
                        {formatDate(conv.date)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 12,
            padding: '16px 24px 24px 24px',
            background: '#FFF',
            borderTop: 'none'
          }}
        >
          <button
            onClick={onClose}
            style={{
              background: '#FFF',
              border: '1px solid #E5E5E5',
              borderRadius: 8,
              padding: '8px 20px',
              fontSize: 15,
              color: '#111827',
              fontWeight: 500,
              cursor: 'pointer',
              transition: 'background 0.15s',
              minWidth: 70,
            }}
            onMouseOver={e => (e.currentTarget.style.background = '#F8F9FA')}
            onMouseOut={e => (e.currentTarget.style.background = '#FFF')}
            tabIndex={0}
          >
            取消
          </button>
          <button
            onClick={handleConfirmDelete}
            disabled={!hasSelection}
            style={{
              background: hasSelection ? '#4F46E5' : '#E5E5E5',
              color: hasSelection ? '#FFF' : '#9CA3AF',
              border: 'none',
              borderRadius: 8,
              padding: '8px 20px',
              fontSize: 15,
              fontWeight: 500,
              cursor: hasSelection ? 'pointer' : 'not-allowed',
              minWidth: 110,
              transition: 'background 0.15s, color 0.15s'
            }}
            tabIndex={0}
          >
            确认删除{hasSelection ? ` (${selected.length})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}
