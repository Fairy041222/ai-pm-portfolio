# AIPM Bench

让 AI 产品经理在 10 分钟内完成模型选型，而不是 2-4 小时。

---

## 💡 为什么做这个？

2024年Q3，国内可用的大模型超过20个，企业平均同时评估3-5个模型。模型选型已成为AI应用落地的首要瓶颈。

AI产品经理每周平均花3-5小时手动对比模型，结论因人而异、难以复用。

**AIPM Bench的解决方案：**

> 输入场景 -> 自动生成测试用例 -> 批量调用多个模型 -> 输出可直接复制到PRD的报告

决策耗时从 **2-4小时** 缩短到 **10分钟以内**。

---

## 🎯 核心功能

| 功能 | 说明 |
| --- | --- |
| 📝 场景输入 | 自然语言描述任务需求 |
| 🤖 自动生成用例 | 5条用例（正常/边界/异常） |
| 🔄 多模型对比 | DeepSeek / Hy3 / Qwen / 讯飞 |
| 📊 规则化报告 | 推荐 + 对比表 + 成本分析 |
| 📋 一键复制 | Markdown报告，直接贴进PRD |
| 💾 历史任务 | 保存在本地，可复用 |

v1.1规划中：Prompt生成与多版本对比

---

## 🚀 快速开始

```
git clone https://github.com/yourusername/aipm-bench.git
cd aipm-bench

# 后端
cd backend
pip install -r requirements.txt
python app.py

# 前端（新终端）
cd ../frontend
npm install
npm run dev
```

---

## 🏗️ 技术架构

```
前端(React) -> 后端代理层 -> 模型适配器 -> 各厂商API -> 规则引擎 -> 报告生成
```

核心设计：

- **模型适配层**：每个厂商独立适配器，新增模型不改核心代码
- **规则化报告**：不调用LLM，基于成本/耗时/成功率计算
- **安全**：API Key后端加密存储，前端永不接触明文

---

## 📊 核心指标

| 指标 | 目标 | 当前 |
| --- | --- | --- |
| 操作步骤 | 5步 | 达标 |
| 评测耗时 | 60秒 | 约45秒 |
| 单次成本 | 0.6元 | 约0.3元 |
| 评测成功率 | 95% | 约98% |
| 报告复制率 | 70% | 收集中 |

---

## 📈 实测数据（3模型 x 5用例）

| 模型 | 成功率 | 平均耗时 | 成本 |
| --- | --- | --- | --- |
| DeepSeek | 100% | 8.8秒 | 0.05元 |
| Hy3 preview | 100% | 14.0秒 | 0.07元 |
| Qwen | 100% | 18.1秒 | 0.07元 |
| 讯飞 Spark Lite | 100% | 4.9秒 | 0.03元 |

---

## 🐛 踩坑记录

**1. API Key每次重启都要重新输入**

- 原因：只存在前端内存
- 解决：后端加密存储 + 前端只存布尔值
- 状态：✅已修复

**2. 一个模型Key错误，整个评测全挂**

- 原因：错误处理缺失
- 解决：前置校验 + 失败跳过 + 自动重试
- 状态：✅已修复

**3. 报告太简单，只有"推荐xx模型"**

- 原因：没展示详细数据
- 解决：增加对比表 + 评分维度 + 原始数据附录
- 状态：✅已修复

---

## 📁 项目结构

```
aipm-bench/
├── frontend/          # React + Vite
├── backend/
│   ├── adapters/      # 各模型适配器
│   ├── core/          # 用例生成 + 评测 + 报告
│   └── routes/        # API
├── docs/
│   ├── BRD.md         # 商业需求文档
│   └── PRD.md         # 产品需求文档
└── docker-compose.yml
```

---

## 🗺️ 路线图

- [✔] v1.0 模型选型（MVP）
- [ ] v1.1 Prompt优化
- [ ] v1.2 用户登录 + 团队协作
- [ ] v1.3 私有化部署

---

## 📄 文档

- [AIPM Bench BRD.pdf](https://www.notion.so/AIPM-Bench-BRD-c31b1317da604ca79deda424be0fa667?source=copy_link)
- [AIPM Bench PRD.pdf](https://www.notion.so/AIPM-Bench-PRD-48e3f7328ef14f32b241414da7d6b806?source=copy_link)
- [AIPM Bench Figma UI](https://www.figma.com/design/NEyiquVyNR26AkhF6tbGcM/AIPM-Bench?node-id=0-1&t=SN8DHvEHVAHehX0w-1)

---

如果这个项目帮到了你，请给个 Star ⭐
