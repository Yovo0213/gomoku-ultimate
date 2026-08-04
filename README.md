# 落与砚的五子棋

一个只在本机运行的双人五子棋：落在浏览器里落子，砚通过本机 Codex App Server 选择自己的下一手，并留下一句简短的话。

## 当前第一版

- 15×15 棋盘、胜负判断、悔棋、换边和棋谱。
- 固定为落与砚对局，不展示通用 AI 模式、难度菜单或竞技倒计时。
- 本地棋力模块只提供候选点；最终落子由 Codex 选择。
- Codex 返回的坐标会在服务端和浏览器端分别校验，非法位置不会写入棋局。
- Codex 断开或输出无效时明确停住，不会切换成本地机器人冒充砚。
- 桌面和手机宽度均可使用。

## 本地运行

需要 Node.js 20+、npm，以及已能在本机使用的 `codex` CLI：

```bash
npm ci
npm run dev
```

打开 `http://127.0.0.1:8082/`。

正式构建与本地服务：

```bash
npm run build
npm start
```

可选环境变量：

- `LUO_GOMOKU_MODEL`：棋手模型，默认 `gpt-5.3-codex-spark`。
- `LUO_GOMOKU_PORT`：正式服务端口，默认 `8082`。
- `LUO_GOMOKU_WORKSPACE`：Codex 轻量棋局任务的本地工作目录。

## 验证

```bash
npm test
npm run build
```

测试覆盖基础棋局、异步旧回合隔离、棋盘输入校验、Codex JSON 解析与非法落子拒绝。

## 来源与许可

本项目 fork 自 [hkm-a/gomoku-ultimate](https://github.com/hkm-a/gomoku-ultimate)，沿用其 MIT 许可的棋盘、规则与搜索基础，并在此基础上加入本地 Codex 棋手协议、双重落子校验、私人对局界面和本地服务层。许可证见 [LICENSE](LICENSE)。
