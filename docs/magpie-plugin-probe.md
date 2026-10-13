# Magpie 插件生命周期探针

此 runner 使用安装好的 Magpie Web 和它启动的 Bun 插件宿主，验证插件安装、持续 tick、追加记录只消费一次、关闭后停机、重新开启续读，以及完整 Web 重启后的恢复。插件只读取临时配置目录中的合成 `fixture.jsonl`；不注册 provider、模型、认证、工具或会话监听，也不连接 Relay。

## 运行

要求 Node.js 24+、本机已有 Magpie CLI 与 Magpie 自带 Bun。runner 只复用传入的可执行文件，不安装或下载运行时。示例路径适用于本机 Magpie 0.1.1211：

```sh
node scripts/ci/magpie-plugin-probe.mjs \
  --magpie /Users/wenzhengfeng/.local/bin/magpie \
  --bun /Users/wenzhengfeng/.cache/magpie/bun/1.4.2/magpie-bun
```

它为每次运行创建独立临时 `HOME`/`XDG_*`、随机 Web key 和 loopback 端口；子进程环境使用白名单，不继承调用者的账号或 API key。Web 以 `magpie web --no-open --gateway --addr ...` 启动，不调用瞬时 CLI 来代替持久插件宿主。runner 通过已安装 Magpie 的 `/api/plugins`、`/api/plugins/add` 和 `/api/plugins/off` 管理接口操作，这些是 Plugins 页面使用的接口。当前环境无法从浏览器访问该 loopback 地址，因此报告会标明未做视觉点击验证。

所有 runner 创建的 Magpie Web 进程都会在退出时停止；Bun 插件 PID 只有在验证为该 Web 进程的子进程时才会被清理。报告记录版本、平台、每项验收门、进程清理状态和失败原因，不记录随机 Web key。默认报告写入 git 忽略的 `reports/magpie-plugin-probe/<run-id>/report.{json,md}`，可用 `--report-dir` 指定其他位置。

## 本地 runner 检查

```sh
node --test tests/ci/magpie-plugin-probe.test.mjs
npx eslint scripts/ci/magpie-plugin-probe.mjs tests/ci/magpie-plugin-probe.test.mjs
```

这两项不启动 Magpie；真实生命周期验收须单独运行上面的 E2E 命令。探针证明的是 Magpie 插件加载与重启/续读生命周期，不代表现有监控服务或手机端集成已经完成。

## 实测结果

2026-10-12（本地日期）在 macOS arm64 用 Magpie `0.1.1211` 和其自带 Bun `1.4.2` 完成一轮真实 Web 生命周期 E2E：**11/11 gates 通过**，耗时约 15.3 秒。Web PID `9359` 创建并持续持有插件子进程 `9453`；tick 从 1 推进到 4，合成序号 1、2 各消费一次。关闭后 tick 在 3.5 个周期内保持 6，旧插件进程退出；重新开启后新子进程 `9524` 从 cursor 2 恢复并消费序号 3。完整停止并重启 Web 后，新 Web PID `9527` 下的插件 PID `9530` 从 cursor 3 恢复并消费序号 4，没有用 CLI 或插件 API 预热宿主。清理 gate 通过，所有 runner-owned 进程退出。

成功报告保存在本机忽略目录 `reports/magpie-plugin-probe/second-e2e/report.{json,md}`。首次尝试因插件安装 POST 使用 5 秒超时而失败；调整为较长的 mutation timeout 后复跑成功，失败记录仍在 `reports/magpie-plugin-probe/first-e2e/report.json`。目前只有 macOS arm64 实测；Windows/Linux 尚未验证。验证使用临时隔离配置，没有安装或改写生产用户配置。它只证明 Magpie 插件生命周期和合成文件续读，不验证会话监听、会话重命名、活动采集、Relay 或手机端集成；UI 按钮未做视觉点击验收，使用的是 Plugins 页面对应的本地管理 API。

最终代码再次完整复跑通过，记录为 `reports/magpie-plugin-probe/final-e2e/report.{json,md}`：E2E 11/11 gates、Node CI 8/8、Bun 4/4、全局 npm lint 均通过。该 final-e2e 报告对应当前代码。
