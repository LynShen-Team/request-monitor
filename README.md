# 数据大屏

给 LLM API 网关用的请求调度大屏：在地球或平面地图上看请求从用户地区到网关、再被调度到上游的过程，带实时指标和 24 小时 / 7 天 / 30 天回溯。

本项目出自 [LynShen](https://lynshen.org)。计划支持的网关：LynShen、sub2api、new-api。

## 现在做到哪了

| 部分 | 状态 |
| --- | --- |
| 页面（`web/`） | 可用，目前只有预览模式：读内置的合成样例数据，不发任何网络请求 |
| 服务（`server/`） | 还没有实现。规格在 `docs/spec-service.md` |

所以现在能做的只有看预览。接真实网关要等服务做出来。

## 看预览

```bash
cd web
bun install
bun run dev            # http://localhost:5173
bun run build:single   # 生成 dist-single/ops-screen.html，双击即可打开
```

网址参数：`?view=2d`、`?range=24h|7d|30d`、`?theme=auto|day|night`、`?day=7-18`（白天的小时范围）、`?as=user|guest`（模拟普通用户或访客）、`?rate=10`（样例流量放大十倍）。

快捷键：1 实时，2 / 3 / 4 回溯，D 切换地球 / 平面，L 切换自动 / 白天 / 夜间，空格 播放 / 暂停。

给预览加上自己的标题和标：写一个 `config.json`（字段见 `web/src/core/config.ts`），然后

```bash
bun run build:single -- --config /path/to/config.json
```

## 设计上的几条规矩

- **只读**：服务只读网关的日志表和渠道表，不往网关写任何东西。
- **浏览器拿不到敏感信息**：客户端 IP、用户名、密钥、请求和回复正文、错误详情、上游主机名都不下发。IP 在服务端用本机离线库换成地区，最细到城市。
- **身份由服务端识别**：管理员、普通用户、访客看到的内容不同；受限分组对非管理员只显示分组名，并且在服务端就合并好。
- **缺的就说缺**：网关没有记录的东西显示「未记录」，不拿假数据填。
- **地图只画海岸线**，不画任何国界或省界。

## 目录

- `web/src/core/`：数据约定（`model.ts`、`identity.ts`、`config.ts`）、引擎、地理工具。
- `web/src/scene/`：WebGL 场景（three.js）、着色器、白天和夜间两套配色。
- `web/src/ui/`：面板、时间轴。
- `web/src/preview/`：合成样例数据和模拟器。
- `docs/spec-screen.md`：页面规格。`docs/spec-service.md`：服务规格（草稿）。

## 许可证

Apache-2.0，见 `LICENSE` 和 `NOTICE`。
