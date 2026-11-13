# Test Cases: 005-sync-workspace（项目目录同步 FS Bridge）

> 覆盖：协议类型、hub 态机/白名单、daemon 终判/分类限额、console 懒加载/查看器、安全与回归。
> 环境：Docker Desktop 栈 `http://localhost:12380`（hub-service/console/nginx）；
> 本机 Node 跑 sync-daemon（examples/sync-daemon.json，host=`laptop-win`）；
> 单测 vitest（tmpdir 合成目录树）；UI 用 Playwright（Chromium）。
> 凭据：admin/viewer 见 examples/hub-service.json（change-me / change-me-too），daemon token `phk_dev_laptop_win`。

## 一、单元测试（vitest，P1 为主）

### TC-001: 白名单段边界前缀匹配（P1，Security）
- **Precondition**: hub fs-paths 纯函数；roots=[`D:\pi-workspace`]
- **Steps**: 分别判定 `D:\pi-workspace\pi-agent-hub`、`D:\pi-workspace-evil\x`、`D:\PI-WORKSPACE\a`（大写盘符）
- **Expected**: 前两者中第一个与第三个放行；`pi-workspace-evil` 拒绝；大小写盘符归一后等价

### TC-002: 路径 resolve 折叠与 NUL 拒绝（P1，Security）
- **Steps**: 判定 `D:\pi-workspace\pi-agent-hub\..\..\other\secret.txt`；传入含 `\0` 的路径
- **Expected**: `..` 折叠后越界 → 拒绝；NUL 路径抛/返回 invalid，不进入 fs 调用

### TC-003: hub cwd 集合收集（P2，Functional）
- **Steps**: 用合成 SessionRow（同 host 多会话重复 cwd、不同 host）调 collectHostCwds
- **Expected**: 按 host 去重；仅返回目标 host 的 cwd 集合

### TC-004: 态机正常迁移（P1，Functional）
- **Steps**: FsRequestStore.create → ack（同 host）→ result(ok:true)
- **Expected**: 状态 dispatched → accepted → completed，result 落记录、时间戳齐全

### TC-005: result 失败迁移（P1，Functional）
- **Steps**: ack 后 result(ok:false, error={code:"denied"})
- **Expected**: state=failed，error 结构完整，error.code 可被前端判别

### TC-006: TTL 惰性 expired（P1，Edge Case）
- **Steps**: 创建记录后模拟时间推进 >60s 再 get
- **Expected**: 首次 get 返回 state=expired；无后台定时器副作用

### TC-007: 终态 5 分钟清理与 404（P2，Edge Case）
- **Steps**: completed 记录推进 >5min 后 get；对从未存在的 id get
- **Expected**: 均返回 undefined（路由层 → 404 not_found）

### TC-008: 跨 host 冒写拒绝（P1，Security）
- **Steps**: 记录属 host A；用 host B 的 token 调 ack/result
- **Expected**: 调用不生效并返回归属错误；记录状态保持 dispatched

### TC-009: daemon 显式白名单放行与拒绝（P1，Security）
- **Precondition**: tmpdir 建 allowed/proj 与 allowed-evil 兄弟目录；fsAllowedDirs=[allowed]
- **Expected**: allowed 内 list_dir 成功；allowed-evil 内请求 → error.code=denied

### TC-010: fsAllowedDirs=[] 全禁（P1，Security）
- **Expected**: 任意路径（含 cwd 内）均 denied_all，且不产生 fs 读取

### TC-011: null 回退 knownCwds 集合（P2，Functional）
- **Precondition**: fsAllowedDirs=null；注入 knownCwds 快照
- **Expected**: 快照内 cwd 下放行，快照外 denied；快照为空时一律 denied

### TC-012: 盘根配置启动报错（P2，Edge Case）
- **Steps**: loadConfig 传入 fsAllowedDirs=["D:\\"] 与 ["/"]
- **Expected**: 抛配置错误，daemon 拒绝启动

### TC-013: symlink 逃逸拦截（P1，Security）
- **Precondition**: allowed 目录内建 symlink 指向 allowed 外真实文件
- **Steps**: readFile 该 symlink 路径
- **Expected**: realpath 后二次判定失败 → denied，不返回外部文件内容

### TC-014: list_dir 排序与截断（P2，Functional）
- **Steps**: tmpdir 造 z-dir、a-dir、b-file、a-file 与 >2000 子项
- **Expected**: 目录在前文件在后、各自名称升序；truncated=true 且 entries 长度=2000

### TC-015: 文件分类命中（P1，Functional）
- **Steps**: 分别 readFile .ts/.md/.png/.mp4/.pdf/.bin
- **Expected**: 文本返回 type=text + UTF-8 content；图片/视频/pdf 返回 dataUrl 与正确 MIME；.bin → binary_unsupported

### TC-016: 大小限额（P1，Edge Case）
- **Steps**: 造 1MB+1B 文本、10MB+1B 图片
- **Expected**: 均 file_too_large，message 含实际/上限字节

### TC-017: 类型不符与不存在（P2，Edge Case）
- **Expected**: 对文件调 list_dir → not_a_directory；对目录调 read_file → not_a_file；不存在路径 → not_found

### TC-018: 文本解码失败（P3，Edge Case）
- **Steps**: 造含非法 UTF-8 字节、扩展名 .txt 的文件
- **Expected**: text_decode_failed，不抛未捕获异常

## 二、hub-service 后端 API（curl，Docker 栈）

### TC-019: 发起 list_dir 全流程（P1，Integration）
- **Precondition**: daemon 在线，库中存在 host=laptop-win、cwd=`D:\pi-workspace` 的会话
- **Steps**: admin 登录取 Cookie/CSRF；POST /api/hub/fs-requests {hostId,kind:"list_dir",path:cwd}；1s 轮询 GET
- **Expected**: 202 {requestId,state:"dispatched"}；轮询经 accepted 到 completed；entries 与本机 `ls D:\pi-workspace` 一致

### TC-020: read_file 文本（P1，Integration）
- **Steps**: 对 `D:\pi-workspace\pi-agent-hub\README.md` 发起 read_file
- **Expected**: completed，type=text，content 为 UTF-8 原文且 size 正确

### TC-021: viewer 发起被拒（P1，Security）
- **Steps**: viewer 登录后 POST fs-requests
- **Expected**: 403 forbidden_role；viewer GET 已知 requestId 仍 200（GET 不限制角色）

### TC-022: CSRF 失败（P2，Security）
- **Steps**: admin Cookie 但不带/错带 X-CSRF-Token POST
- **Expected**: 403 csrf_failed

### TC-023: host_unknown（P2，Edge Case）
- **Steps**: hostId 传不存在的 `no-such-host`
- **Expected**: 404 host_unknown

### TC-024: 第一道白名单拒绝（P1，Security）
- **Steps**: path 传 `D:\pi-workspace-evil`（非任何会话 cwd 之下）
- **Expected**: 403 path_not_allowed，daemon 侧无对应 fs_request 事件

### TC-025: 参数非法（P2，Edge Case）
- **Steps**: path=""、kind="delete"、缺字段各一次
- **Expected**: 400 invalid_request

### TC-026: host 离线 503 且无悬空记录（P1，Integration）
- **Precondition**: 停止 daemon，SSE 断开
- **Steps**: 发起请求
- **Expected**: 503 host_offline；用返回信息确认无 requestId（不建记录）；daemon 恢复后新请求正常

### TC-027: daemon 错误回传收敛（P1，Integration）
- **Steps**: daemon 配置 fsAllowedDirs=[] 后发起请求
- **Expected**: 轮询得 state=failed、error.code=denied_all（HTTP 仍 200，错误在体内）

### TC-028: 轮询未知 id（P2，Edge Case）
- **Expected**: GET /api/hub/fs-requests/fsr_nonexistent → 404 not_found

### TC-029: Bearer 鉴权（P2，Security）
- **Steps**: 无/错 token 调 /api/v1/fs-requests/:id/ack
- **Expected**: 401 token_unknown

## 三、hub-console 前端（Playwright）

### TC-030: 右栏真实目录懒加载（P1，UI）
- **Steps**: admin 登录 → 选中 cwd=`D:\pi-workspace` 的会话 → 观察右栏
- **Expected**: 自动列出根目录；展开 pi-agent-hub → packages 逐级加载；节点显示目录/文件图标与 size/mtime，无 touchedBy 标签

### TC-031: 目录缓存与切换取消（P2，UI）
- **Steps**: 展开若干目录后切走再切回同会话；快速连续切换不同会话
- **Expected**: 已加载目录命中缓存不重复请求；切换后旧轮询停止（网络面板无悬空 fs-requests 轮询）

### TC-032: 文本/markdown 渲染（P1，UI）
- **Steps**: 点击 README.md 与某 .ts 文件
- **Expected**: .md 走 MdPreview 渲染；.ts 走 pre 代码样式；头部显示路径

### TC-033: 图片/PDF 渲染（P2，UI）
- **Steps**: 点击仓库内 .png 与（若有）.pdf
- **Expected**: img 直接显示；pdf iframe 内嵌；video 控件（如存在 mp4 测试样本）

### TC-034: 错误态展示（P2，UI）
- **Steps**: 触发 denied/file_too_large/binary_unsupported（可用 tmpdir 样本或配置切换）
- **Expected**: el-alert/el-empty 明确中文提示，无未捕获异常，轮询停止

### TC-035: 前端超时提示（P2，Edge Case）
- **Steps**: 模拟 daemon ack 后不回 result（或临时断网），等待 list_dir 30s
- **Expected**: 停止轮询并提示「主机响应超时」

### TC-036: viewer 空状态（P1，UI/Security）
- **Steps**: viewer 登录进入查看器
- **Expected**: 右栏文件 tab 显示「目录浏览需要管理员权限」，网络面板无 fs-requests 请求；子 agent tab 正常

### TC-037: 轮询节奏与卸载（P3，Performance）
- **Expected**: 未完成时间隔稳定 1s；组件卸载后无定时器残留、无控制台报错

## 四、回归

### TC-038: 既有 SSE 下行链路不受影响（P1，Regression）
- **Steps**: 发起一次 delivery（会话下发）并完成 ack/result
- **Expected**: deliver 事件分支行为与改动前一致；import/export 占位路由不变

### TC-039: 虚拟文件树接口保留（P2，Regression）
- **Steps**: GET /api/hub/sessions/:id/files 与 /files/content
- **Expected**: 仍返回 202 时期结构（接口未删除）；SubagentPanel 数据正常

### TC-040: 全仓质量门禁（P1，Regression）
- **Steps**: `pnpm typecheck`、`pnpm test`、`pnpm build`
- **Expected**: 零新增类型错误；全部 vitest 用例通过；构建成功；无 as any/ts-ignore/空 catch 新增

## 优先级汇总

| 优先级 | 用例 |
|---|---|
| P1 | 001/002/004/005/006/008/009/010/013/015/016/019/020/021/024/026/027/030/032/036/038/040 |
| P2 | 003/007/011/012/014/017/022/023/025/028/029/031/033/034/035/039 |
| P3 | 018/037 |
