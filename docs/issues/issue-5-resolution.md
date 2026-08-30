# Issue #5 response draft

感谢你提供非常完整的 Linux 复现、根因分析和最小脚本。这个问题已在
`dsh-knowledge@0.3.5` 中修复。

修复没有继续采用延长空闲时间的临时绕过，而是调整了 worker 生命周期：空闲超时
现在只向现有 worker 发送 `release-models`，在同一个 worker 内调用
`pipeline.dispose()` / `model.dispose()` 释放 ONNX session，不再 terminate 后重新
创建 worker。因此 `onnxruntime-node` 原生绑定在宿主进程生命周期内只注册一次，
后续请求会在原 worker 内从磁盘重新加载模型。

同时还完成了两项配套修复：

- 模型释放和下一次加载通过同一条 operation chain 串行执行，避免 dispose/reload
  竞态；
- 模型文件存在但运行时启动失败时，错误提示会建议检查运行时或重启服务，不再误导
  用户重新下载完好的模型。

维护侧使用真实 Qwen3 embedding 模型完成了 10 轮“加载 → 释放 → 重新加载”验证，
没有再次出现 `Module did not self-register`，并加入了 worker 生命周期回归测试。

请在方便时升级到 `dsh-knowledge@0.3.5` 或更高版本，并在原来的 Linux x64 / Node
24 环境下确认一次“空闲超过 60 秒后再次检索”。如果仍能复现，请附上新的启动日志
和 `dsh-knowledge` 版本；如果已经恢复正常，这个 Issue 就可以按已完成关闭。
