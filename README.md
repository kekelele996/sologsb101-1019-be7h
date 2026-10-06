# 古籍修复工序与补纸配色档案（gbbookrestore）

面向图书馆古籍修复室修复师的本地化档案工具：按叶登记破损状况、选配补纸并逐道记录修复工序，最终还原装订形式并归档验收结论。

核心动作：**建立古籍与册次 → 逐叶登记破损类型与面积 → 选配补纸并做染色比对 → 记录补破托裱等工序 → 登记装订还原与验收归档**。

纯前端单页应用（Vue 3 + TypeScript + Element Plus + Vite + Pinia + Vue Router），**无后端、无数据库服务、无 API 服务**，全部数据保存在浏览器本地（IndexedDB / Dexie + 少量 localStorage 元数据）。

---

## 一、Docker 一键启动（推荐）

```bash
# 1. 首次启动先复制环境变量模板
cp .env.example .env

# 2. 构建并启动
docker compose up -d --build
```

启动完成后访问：**http://localhost:22819**

常用命令：

```bash
docker compose ps                 # 查看服务状态（healthy 表示就绪）
docker compose logs -f frontend   # 查看 nginx 日志
docker compose down               # 停止并移除容器
docker compose up -d --build      # 代码改动后重新构建
```

> 端口可在 `.env` 中通过 `FRONTEND_PORT` 修改；容器名固定为 `${COMPOSE_PROJECT_NAME:-gbbookrestore}-frontend`。
> 容器无状态：不连接数据库、不挂载命名卷，数据全部在浏览器本地；迁移设备请使用 `/export` 页的「导出 / 导入 JSON 备份」。

---

## 二、技术栈

| 分类 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3（`<script setup>` + Composition API） | 页面按路由懒加载 |
| 语言 | TypeScript（`strict: true`，`noUnusedLocals`） | `npm run build` 内含 `vue-tsc --noEmit` 类型检查 |
| UI 组件库 | Element Plus 2.x（含 `@element-plus/icons-vue`） | 表格、表单、对话框、单选按钮组、空态 |
| 构建工具 | Vite 6 | 开发服务器端口 22819 |
| 状态管理 | Pinia（setup store） | `bookStore` / `leafStore` / `repairStore` |
| 路由 | Vue Router 4（history 模式） | nginx 侧配合 `try_files` 做 SPA fallback |
| 本地存储 | Dexie 4（IndexedDB 封装）+ localStorage | 含数据结构版本号与 v1→v2、v2→v3 升级迁移 |
| 容器化 | Docker 多阶段构建：`node:20-alpine` → `nginx:alpine` | 构建阶段类型检查 + 打包，运行阶段仅托管静态产物 |

---

## 三、本地开发方式

```bash
cd frontend
npm install
npm run dev        # 开发服务器 http://localhost:22819
npm run build      # 类型检查 + 生产构建，产物在 frontend/dist
npm run preview    # 本地预览构建产物（http://localhost:22819）
```

要求 Node.js 20 及以上（与 Docker 构建阶段镜像 `node:20-alpine` 保持一致）。

---

## 四、页面与路由

| 路由 | 页面 | 主要职责 | 消费模型 |
| --- | --- | --- | --- |
| `/books` | 古籍与册次台账 | 新建古籍、按年代与保护级别筛选（同步 URL query），对话框内管理册次，装订完成后整册锁定只读 | Book、Volume |
| `/books/:id/leaves` | 书叶破损登记 | 册次切换、逐叶录入破损类型（可叠加）、面积与 pH，批量改状态；**直接深链不存在的 id 显示友好空态** | Leaf、Volume |
| `/papers` | 补纸选配与染色比对 | 按 ΔE 升序排列候选补纸、帘纹匹配度与综合评分，ΔE 超阈值提示重新染色 | Paper、Leaf |
| `/repairs` | 修复工序记录 | 拖拽调整工序先后并重编号、回填材料与操作人，完成即回写书叶状态，一键生成标准序列 | RepairOrder、Leaf |
| `/consigns` | 送修对账与补纸领用 | 接收/改约外单位送修单（只追加、晚到为准）、按送修编号+册次号对账（对上挂标记、认不上挂待认领）、补纸领用超约定挂待补办并卡验收 | ConsignManifest、ConsignIntake、PaperRequisition、Volume |
| `/export` | 装订还原与验收归档 | 装订登记 + 验收结论（合格触发全册归档；**送修册待补办未清 / 未对上不许合格验收**）、JSON 导入导出、归档清单与破损台账 CSV | Binding 及全部模型 |

`/` 与未匹配路径重定向到 `/books`。筛选条件写入 URL query（`?kw=&damageType=&state=` 等），可从任意设备复用链接。

---

## 五、数据模型

| 模型 | 文件 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| Book 古籍 | `src/types/book.ts` | `id` `title` `edition` `era` `volumeCount` `collectionNo` `level`（一级/二级/三级/普通） | 新建后进入册次登记，卡片回显待修叶数与已完成工序数 |
| Volume 册次 | `src/types/volume.ts` | `id` `bookId` `volumeNo` `leafCount` `bindingType`（线装/蝴蝶装/包背装） `state`（待修复/修复中/已装订/已归档） `consignNo` `ownerUnit`（v3 送修标记，缺省为空=未送修） | 装订完成后整册锁定为只读；对上外单位送修册时挂送修编号，破损与工序照旧 |
| Leaf 书叶 | `src/types/leaf.ts` | `id` `volumeId` `leafNo` `damageType`（虫蛀/酸化/絮化/缺肉/水渍） `damageAreaCm2` `phValue` `state`（待修/修复中/已修复） | 同叶可叠加多种破损，按册汇总面积与平均 pH |
| Paper 补纸 | `src/types/paper.ts` | `id` `leafId` `paperType`（竹纸/皮纸/宣纸） `laidPattern` `thicknessMm` `deltaE` `dyeRecipe` | 按色差排序候选，ΔE 超阈值提示重新染色 |
| RepairOrder 修复工序 | `src/types/repairOrder.ts` | `id` `leafId` `seq` `name`（补破/托裱/溜口/裁齐/压平） `material` `operator` `date` `state`（未开始/进行中/已完成） | 拖拽调序，完成即回写书叶状态 |
| Binding 装订 | `src/types/binding.ts` | `id` `volumeId` `method` `finishDate` `verdict`（合格/返修） `inspector` | 合格触发全册归档，返修退回修复中 |
| ConsignManifest 送修单 | `src/types/consignManifest.ts` | `id` `consignNo`（送修编号） `volumeNo`（外单位册次号） `ownerUnit` `paperType` `agreedSheets` `receivedAt`（到达时间） `remark` | **外单位账本**，只追加；同一（编号+册次+纸种）以 `receivedAt` 最晚一份为准（改约晚到覆盖），修复室不改不删 |
| ConsignIntake 对认记录 | `src/types/consignIntake.ts` | `id` `consignNo` `volumeNo` `ownerUnit` `volumeId` `state`（已对上/待认领） `claimedAt` | **修复室账本**；按送修编号+册次号对本室册次，对上的册次在 `Volume.consignNo` 挂送修标记，认不上挂待认领等人工认册 |
| PaperRequisition 补纸领用 | `src/types/paperRequisition.ts` | `id` `volumeId` `paperType` `usedSheets`（累计张数） `date` `note` | **修复室账本**；超约定张数实时算「待补办」，未清不许并入验收，对方改约追加后自动解除 |

Volume 在 v3 新增 `consignNo` / `ownerUnit` 两个送修标记字段（挂在外单位对上的册次上，仅标记归属；破损、工序、装订流程完全照旧）。

数据结构版本号 `DB_VERSION` 定义在 `src/utils/db.ts`，当前为 `v3`：

- `v1→v2`：`papers` 表增加 `dyeRecipe` 字段，并在 Dexie `.upgrade()` 中按纸种回填默认染色配方（竹纸 / 皮纸 / 宣纸 各有基准配方）。
- `v2→v3`：新增 `consignManifests` / `consignIntakes` / `paperRequisitions` 三张表，`volumes` 增加 `consignNo` 索引；**旧册次在 `.upgrade()` 中统一回填 `consignNo = null`，按未送修显示**，原有破损与工序数据一律不动。旧版本备份导入时由 `normalizeSnapshot()` 做同样补齐。

### 送修业务边界（两个限界上下文，各管各的）

| 规则 | 落地方式 |
| --- | --- |
| 外单位只登记送修编号、册次号、约定纸种张数 | `consignManifests` 独立表；`/consigns` 左栏只支持「接收 / 改约登记」，无编辑 / 删除入口 |
| 修复室只管古籍、册次、书叶、工序 | 送修标记只挂在 `Volume.consignNo`；破损（Leaf）、工序（RepairOrder）模型零改动 |
| 收册按送修编号 + 册次号对，对上挂标记 | `planReconcile()` 严格双键匹配自动对上；`ConsignIntake` 记录对上 / 待认领 |
| 领用超出约定的部分挂待补办，不许并进验收 | `paperHoldings()` 按现行约定实时算超领张数；`acceptanceBlockForVolume()` 作为验收闸门，在 `/export` 合格提交与按钮上拦截 |
| 中间改约以晚到那份为准 | `effectiveAgreements()` 同键取 `receivedAt` 最晚行；早到行保留留痕但不再生效，超领状态随之自动解除 |
| 做完的工序别被改回去 | 接收送修单只 `bulkPut(consignManifests)`，事务不包含任何修复室表 |
| 认不上的先挂待认领 | 对不上键建 `state='unclaimed'` 行；人工「认册」校验册次号一致且未挂别的送修编号 |
| 修复室写库失败只重试本侧几条，送修册原样不动 | `withStudioRetry()` 的事务表白名单 `STUDIO_TABLES` 不含 `consignManifests`，指数退避重试至多 3 次 |
| 旧数据升级按未送修显示 | v3 `.upgrade()` 回填 `consignNo/ownerUnit = null`；`isConsignedVolume()` 统一判定 |

---

## 六、目录结构

```
sologsb101-1019/
├── frontend/                     # 前端源码
│   ├── src/
│   │   ├── types/                # book.ts volume.ts leaf.ts paper.ts repairOrder.ts binding.ts consignManifest.ts consignIntake.ts paperRequisition.ts
│   │   ├── stores/               # bookStore.ts leafStore.ts repairStore.ts consignStore.ts
│   │   ├── components/common/    # DamageTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
│   │   ├── hooks/                # useLeafStats.ts useIdbTable.ts useConsignOverview.ts
│   │   ├── pages/                # BookList.vue LeafBoard.vue PaperMatch.vue RepairWorkflow.vue ConsignBoard.vue ExportView.vue
│   │   ├── router/               # index.ts
│   │   ├── utils/                # paperColor.ts db.ts export.ts consign.ts
│   │   ├── styles/               # main.css
│   │   ├── App.vue main.ts env.d.ts
│   ├── public/favicon.svg
│   ├── index.html package.json tsconfig.json vite.config.ts
│   ├── Dockerfile                # 多阶段构建（node:20-alpine → nginx:alpine）
│   ├── nginx.conf                # SPA fallback + gzip + 静态资源缓存
│   └── .dockerignore
├── docker-compose.yml            # 顶层 name、container_name、端口映射
├── .env / .env.example           # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── .gitignore
└── README.md
```

分层约定：页面只读 Pinia store，跨页状态不留在组件内部 `ref`；IndexedDB 读写统一走 `useIdbTable()`（`liveQuery` 响应式订阅）；筛选条件与 URL query 通过 `FilterBar.vue` 导出的 `useFilterQuery()` 同步。

---

## 七、数据存储说明

- **IndexedDB（Dexie，数据库名 `gbbookrestore`）**：9 张业务表 `books` / `volumes` / `leaves` / `papers` / `repairOrders` / `bindings` / `consignManifests` / `consignIntakes` / `paperRequisitions`，由 `src/utils/db.ts` 统一定义 schema、版本号与升级迁移；`initDatabase()` 首次打开时自动播种**三层互相引用**的演示数据（Book → Volume → Leaf → Paper / RepairOrder，另有 Volume → Binding，固定 id 如 `book_01`、`vol_0101`、`leaf_010101`；v3 另播种一部含改约、待认领与超领待补办的送修古籍 `book_04` / `vol_0401`），保证 `/books/:id/leaves` 深链能命中真实 id，播种幂等。
- **localStorage**：仅存元数据 —— `gbbookrestore:db-version`（本地结构版本）、`gbbookrestore:last-backup-at`（最近导出时间）、`gbbookrestore:ui-prefs`（当前古籍 / 册次、工序排序方式）。
- **备份**：`/export` 页可导出 JSON（9 张表全量数据 + 结构版本号），导入时校验 `app` 字段与六个核心集合数组完整性（v3 新集合缺省按空集补齐），覆盖导入前二次确认；另有归档清单 TXT 与书叶破损台账 CSV。
- **隐私与无状态**：数据不上传任何服务器，容器不挂载命名卷；清理浏览器站点数据或更换浏览器会丢失档案，请定期导出备份。

---

## 八、开发提示

- 类型检查与构建：`cd frontend && npm run build`（含 `vue-tsc --noEmit`，必须零错误）。
- 端口一致性：开发服务器（`vite.config.ts`）、预览服务、compose 的 `FRONTEND_PORT` 默认值均为 `22819`。
- 若部署在中文路径下，`docker-compose.yml` 顶层的 `name: gbbookrestore` 可保证项目名不为空，`docker compose config --quiet` 不会报错。
- 容器运行阶段执行了 `RUN chmod -R a+rX /usr/share/nginx/html`，避免宿主机静态资源权限为 0600 时 nginx worker 读取失败返回 403。
