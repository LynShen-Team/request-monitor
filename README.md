# 数据大屏

给 LLM API 网关用的请求调度大屏：在地球或平面地图上看请求从用户地区到网关、再被调度到上游的过程，带实时指标和 24 小时 / 7 天 / 30 天回溯。

本项目出自 [LynShen](https://lynshen.org)。计划支持的网关：LynShen、sub2api、new-api。

## 现在做到哪了

| 部分 | 状态 |
| --- | --- |
| 页面（`web/`） | 可用。两种数据来源：内置的合成样例（预览），或者下面这个服务 |
| 服务（`server/`） | 能读 LynShen 网关的历史日志，算出 24 小时 / 7 天 / 30 天回溯给页面；能按网关的登录状态认出管理员、普通用户和访客。规格在 `docs/spec-service.md` |

还没做的：

- **实时**：服务还不发实时事件，页面上「实时」是灰的，打开就是 24 小时回溯。
- **sub2api、new-api**：适配还没写，现在只支持 LynShen。
- **真实网关**：读日志和身份识别都只对着仿造的网关测过。

## 看预览（不需要网关）

```bash
cd web
bun install
bun run dev            # http://localhost:5173
bun run build:single   # 生成 dist-single/ops-screen.html，双击即可打开
```

网址参数：`?view=2d`、`?range=24h|7d|30d`、`?theme=auto|day|night`、`?day=7-18`（白天的小时范围）、`?as=user|guest`（模拟普通用户或访客，只在预览里有用）、`?rate=10`（样例流量放大十倍）。

快捷键：1 实时，2 / 3 / 4 回溯，D 切换地球 / 平面，L 切换自动 / 白天 / 夜间，空格 播放 / 暂停，Esc 关闭详情。

地图上的每个地点（来源地区、网关、上游所在地）都可以悬停看摘要、点击看详情：请求数、成功率、模型和渠道分布、最近完成的请求。拖动转动地球，滚轮或触控板捏合缩放。地图的取景按网关、上游和主要来源地区的位置自动算，不用配置。

给预览加上自己的标题和标：写一个 `config.json`（字段见 `web/src/core/config.ts`），然后

```bash
bun run build:single -- --config /path/to/config.json
```

## 跑服务

需要 Go 和 bun。`make build` 先构建页面，再把它打进一个可执行文件。

```bash
cd server
make build                                   # 生成 bin/opsscreen
bin/opsscreen devseed -dir demo              # 写一个编出来的演示网关和配置
bin/opsscreen serve -config demo/config.toml
```

然后打开配置里 `listen` 的地址（默认 `http://127.0.0.1:8787`，端口被占用就改 `listen`）。演示网关里的名字和数字全是编的。

接真实的 LynShen 网关：照 `server/config.example.toml` 写配置，`dsn` 指向网关的 PostgreSQL，用一个只读账号。服务只发读语句。

身份识别：配置里写上 `gateway.api_url`（网关自己的接口地址），并把大屏放在和网关同一个父域名的子域名下，浏览器就会带上网关的登录状态，服务拿它去问网关「这是谁」。不想让没登录的人打开，就设 `access.guests = false` 和 `access.login_url`：没登录的人会看到「请先登录」，登录后回到页面自动打开。服务会经手访客的登录凭证，只能放在和网关同样受信任的机器上。

开发页面时连一个正在跑的服务：

```bash
cd web
OPS_API=http://127.0.0.1:8787 bun run dev
```

## 设计上的几条规矩

- **只读**：服务只读网关的日志表和渠道表，不往网关写任何东西。
- **浏览器拿不到敏感信息**：客户端 IP、用户名、密钥、请求和回复正文、错误详情、上游主机名都不下发。IP 在服务端用本机离线库换成地区，最细到城市。
- **身份由服务端识别**：管理员、普通用户、访客看到的内容不同；受限分组对非管理员只显示分组名，并且在服务端就合并好。
- **缺的就说缺**：网关没有记录的东西显示「未记录」，不拿假数据填。
- **地图只画海岸线**，不画任何国界或省界。

## 目录

- `web/src/core/`：数据约定（`model.ts`、`identity.ts`、`config.ts`）、引擎、地理工具。
- `web/src/scene/`：WebGL 场景（three.js）、着色器、自动取景、白天和夜间两套配色。
- `web/src/ui/`：面板、时间轴、地点详情。
- `web/src/preview/`：合成样例数据和模拟器。
- `web/src/net/`：读服务接口的数据来源。
- `server/`：服务（Go）。读网关、存聚合结果、给页面提供接口，并带着构建好的页面。
- `docs/spec-screen.md`：页面规格。`docs/spec-service.md`：服务规格。

## 许可证

Apache-2.0，见 `LICENSE` 和 `NOTICE`。
