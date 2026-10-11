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
客户端/远程 Hub 不得直接依赖这个本地操作者权限边界：后续需要单独的鉴权运输层。

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

## 下一步必须完成（不能拿本片替代）

1. Hub 的 daemon 管理权限、非秘密意图队列、仅目标 daemon 拉取、请求/回执匹配、重连补拉。
   普通任务/审计/响应不得保存 key 或 OAuth 内容；密钥传递另走现有安全链路。
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

- 启动：不新增常驻进程；权威入口 `agent-network/bin/cli.ts` 的 daemon provider 分支。
- 拓扑：无端口、反代或隧道改动。
- 密钥：本地操作者经 stdin 提供，daemon 私有 provider-store/state.json 持有。
  不入 Git、不回读、不声称磁盘加密；生产备份必须加密并限制访问。
- 换版：只能使用 main 正式发布物。list 回读 scope/revision；本测试分支不得部署为正式版本。
- 回滚：旧版本不会消费新增存储；保留私有目录，不删除原 node config、登录或其他数据。
  不将回滚软件等同撤销已外泄供应商 key；后者需供应商侧撤销。
- 数据：Git 只能重建实现，不能重建账号/key/用户配置。加密备份目的地、密钥保管、保留期尚未
  指定；未做生产恢复演练，不宣称全机可恢复。崩溃遗留锁需操作者核对写进程已终止后处理。
