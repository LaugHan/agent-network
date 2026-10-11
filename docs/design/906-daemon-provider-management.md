# #906 — Daemon Provider 管理首片

状态：实现中，未上线。P0；本片不是 #906 完成验收。

## 用户确认的层级

Daemon → Provider → Runtime（首片 codex-tui）→ 登录 / API Key → 配置 → 模型。
所有者是目标 daemon；runtime 只是兼容维度。官方 ChatGPT 登录和第三方 API Key
不共用凭据，也不因为页面有两种按钮就认定每个 Provider 都支持两种认证。

## 本片已实现的边界

`agent-network/src/daemon-provider-store.ts` 为本地受信操作者提供独立配置存储。
`anet daemon provider list <daemon>` 返回脱敏配置；
`anet daemon provider put <daemon> --revision N` 从标准输入读取不超过 64 KiB 的 JSON。
工作目录沿用现有 CLI 的 `.anet/nodes/<daemon>` 解析，不接受任意路径或命令行 key。
客户端/远程 Hub 不得直接依赖这个本地操作者权限边界。下面的远程协议仅开放脱敏回读，
尚未开放远程写入、凭据运输、登录或节点应用。

配置示例（假数据；真实密钥不得写入 shell 历史、提交或测试镜像）：

```json
{
  "id": "deepseek",
  "label": "DeepSeek",
  "enabled": true,
  "runtimes": [{
    "runtime": "codex-tui",
    "auth": [{
      "id": "work",
      "kind": "api_key",
      "baseUrl": "https://api.example.test/v1",
      "models": ["model-a"],
      "key": "TEST-ONLY-placeholder"
    }]
  }]
}
```

保存后必须读取返回的 revision。更新时省略 key 保留旧 key；端点改变时不复用旧 key，
须显式重输。启用/停用以 enabled 更新；目前不提供删除或运行中绑定变更。
官方账号配置用 Provider `openai`、kind `chatgpt`，不接受 key/baseUrl，
**保存这个元数据不执行登录**，credential_present=false。

存储绑定 `{network_id, daemon_node_id}`；复制到其他 daemon/network 后拒绝读取和写入。
所有输出逐字段构造，不带 key。配置存在仅为 configured，verification=not_checked、
application=not_applied；模型清单是用户配置，不是 entitlement 或实际可用性证明。
目录 0700、文件 0600、写入 fsync + 原子 rename；独占锁和 expected revision 防止覆盖。
锁文件存在时拒绝写入，不能仅因时间长而自动抢锁。未知字段和非法认证组合明确拒绝。

## 远程回读协议（源码已实现，尚未上线）

- 用户侧 MCP `daemon_provider_snapshot`：`action=refresh,id=<daemon_node_id>` 请求刷新；
  `action=read,id=<request_id>` 读取回执，两者传目标 `network_id`。仅该网络人类 owner/admin 可用，
  节点令牌及无用户身份的旧全局模式不能管理其他 daemon 的配置。其他既有 token 功能不变。
- Hub 持久化 `daemon_provider_snapshots`；只含请求元数据及验证过的公开投影，不含 key/OAuth。
  同 daemon 同时最多一条 pending；120 秒过期，7 天后在下一次访问时清理旧回执。
- 目标 daemon 从 `pull_daemon_provider_snapshots` 拉取，通过现有 ANET_BIN 信任根验证启动器，
  使用最小环境执行本地 `provider list`，不接受远端文件路径或命令。SSE 门铃及重连均触发补拉，
  并发门铃合并；传输失败不伪造成功。单次 CLI 10 秒超时，公开快照上限 1 MiB。
- `ack_daemon_provider_snapshot` 只接受目标 daemon 的 token-bound 身份；网络、daemon ID、
  Provider/runtime/auth 字段与枚举逐层验证，未知字段（包括 key）拒绝。首条有效回执胜出，
  重复或超时回执不能覆盖。失败只保存固定错误码，不保存原始 CLI/parser 错误。
- `succeeded` 仅指配置回读成功，`observed_at` 为 Hub 收到回执的时间，不是推理验证时间。
  配置仍是 `not_checked/not_applied`；旧 daemon 不响应时显示 expired，绝不冒充空列表或 Hub 列表。

## 下一步必须完成（不能拿本片替代）

1. 在上述回读链路上扩展受控写入与安全凭据运输；普通任务/审计/响应不得保存 key 或 OAuth 内容。
2. 客户端 Provider 管理页替换演示壳，按上述层级读写同一份真实配置；切换 daemon 丢弃旧请求。
3. 官方账号登录需本人完成，优先核对已安装 Codex 的 device-code 能力和取消/状态接口。
   不复制其他节点 auth.json，不假设共享 refresh-token 安全。
4. 节点绑定 + 模型选择 → 安全应用 → 实际回读 → 独立认证/请求验收。
   不将 metadata 保存成功写成登录成功，不静默跨 Provider / 账号回退。
5. Docker 的认证原子层通过后，再进入完整流程、多用户、安全及原生客户端包验收。

官方依据（2026-10-11 查询；不是安装版本支持证明）：
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex app-server account login / cancel](https://learn.chatgpt.com/docs/app-server)
- [Custom model providers](https://learn.chatgpt.com/docs/config-file/config-advanced)

## 恢复六问

- 启动：不新增常驻进程；权威入口 `agent-network/bin/cli.ts` 的 daemon provider 分支，
  `agent-node/src/runtime/daemon-provider-snapshot.ts` 由既有 daemon 的 SSE/重连处理调用；
  Hub 由 `server/src/tools.ts` 注册协议，`server/src/db.ts` 增量建表。
- 拓扑：无端口、反代或隧道改动。
- 密钥：本地操作者经 stdin 提供，daemon 私有 provider-store/state.json 持有。
  不入 Git、不回读、不声称磁盘加密；生产备份必须加密并限制访问。
- 换版：只能使用 main 正式发布物。list 回读 scope/revision；本测试分支不得部署为正式版本。
- 回滚：旧版本不会消费新增存储和快照表；保留它们，不删除原 node config、登录或其他数据。
  不将回滚软件等同撤销已外泄供应商 key；后者需供应商侧撤销。
- 数据：Git 只能重建实现，不能重建账号/key/用户配置。加密备份目的地、密钥保管、保留期尚未
  指定；未做生产恢复演练，不宣称全机可恢复。崩溃遗留锁需操作者核对写进程已终止后处理。
