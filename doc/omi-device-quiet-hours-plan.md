# OMI 设备夜间静音 / 暂停方案备忘

> 记录时间：2026-04-29  
> 当前状态：方案 A 已实现，云端接收侧静音。  
> 目标：评估是否需要在每天 22:00 到次日 08:00 期间，让 OMI 自动停止采集、停止上传、或至少让本项目云端不处理夜间音频。

## 1. 当前结论

基于 OMI 官方公开文档和开源方向判断，目前没有公开的官方云端 API 可以直接控制 OMI 设备端暂停麦克风、静音、关机或进入睡眠。

官方公开能力更接近以下边界：

- Developer API 主要面向 memories、conversations、action items、API keys 等数据能力。
- Real-Time Audio Streaming 是 OMI App / 设备主动把 PCM 音频推到开发者配置的后端 endpoint。
- App-Device BLE 协议公开的主要服务是 battery、device info、audio data、codec type，没有公开 pause / mute / sleep control characteristic。
- Notification API 可以给用户发通知，但不能直接控制设备麦克风。
- OMI 硬件、固件、App、后端是开源方向，可以通过自定义 App 或固件扩展控制能力，但这不是现成云 API。

因此，当前可行路线不是“调用官方云端 API 关闭设备”，而是分层选择控制点。本项目已先落地方案 A：在云端 WebSocket 音频入口做 quiet hours gate。

## 2. 可选方案

### 2.1 方案 A：云端接收侧静音

在本项目 WebSocket / 音频接收服务侧增加 quiet hours gate。当前实现位置：

- `src/services/quiet-hours.ts`
  - 读取 `QUIET_HOURS_*` 配置。
  - 按指定时区判断当前是否处于 quiet hours。
- `src/handlers/app-connection.ts`
  - 在 WebSocket binary audio 入口最前面判断 quiet hours。
  - 夜间窗口内直接丢弃音频，不写 WAV，不进入 VAD，不发送给 Soniox。
  - 已经开始录音的会话跨入 quiet hours 时，会停止接收、finalize 当前会话并关闭连接。

建议配置：

```env
QUIET_HOURS_ENABLED=true
QUIET_HOURS_TZ=Asia/Shanghai
QUIET_HOURS_START=22:00
QUIET_HOURS_END=08:00
QUIET_HOURS_MODE=drop_audio
```

当前行为：

- 夜间窗口内收到 OMI 音频二进制包时直接丢弃。
- 不写 WAV。
- 不发送给 Soniox。
- 不生成 transcript / conversation segment。
- 已连接且已经开始录音的会话跨入 quiet hours 时自动 finalize 并 close。
- 当前没有新增数据库 schema；日志会记录 `quiet_hours_suppressed`。

优点：

- 对当前项目改动最小。
- 不依赖 OMI 官方新增设备控制 API。
- 可以快速降低夜间隐私风险、转写成本和无效会话噪声。

局限：

- 设备端和手机 App 可能仍在采集或上传。
- 不能降低设备侧功耗。
- 严格意义上不是“设备端静音”，只是“本项目云端不处理”。

### 2.2 方案 B：自定义 OMI App，云端下发策略

如果后续使用自编译 OMI App，可以让 App 从本项目云端拉取策略：

```json
{
  "quiet_hours": {
    "enabled": true,
    "timezone": "Asia/Shanghai",
    "start": "22:00",
    "end": "08:00",
    "mode": "stop_streaming"
  }
}
```

App 侧在夜间窗口内停止连接实时音频 webhook，或停止订阅设备 BLE Audio Data characteristic。

优点：

- 比云端丢弃更接近“暂停上传”。
- 可以减少网络流量和后端压力。
- 不一定需要改设备固件。

局限：

- 需要维护自定义 App。
- 设备是否仍在本地采样，取决于 App 和固件当前交互方式。
- 需要处理 App 离线、时区、系统时间不准、策略同步失败等边界。

### 2.3 方案 C：自定义固件，设备端真正 mute / sleep

如果必须做到设备端麦克风停止采样或设备低功耗睡眠，需要改固件。

可扩展方向：

- 新增 BLE control characteristic。
- 支持 `mute_until`、`sleep_until`、`daily_quiet_hours` 等指令。
- 设备本地保存 schedule。
- 设备通过手机同步时间，离线时也能按本地 schedule 执行。

优点：

- 最接近真正的设备端关闭 / 静音。
- 可以降低设备侧功耗和采集风险。

局限：

- 实施和维护成本最高。
- CV1 固件刷写、OTA、回滚和兼容性都需要额外验证。
- 固件层错误可能影响设备基础可用性。

## 3. 当前建议

方案 A 已开始实现并可通过环境变量开关控制。

观察期内重点确认：

- 夜间是否真的产生大量空会话或无效音频。
- 夜间音频是否进入 Soniox 并产生成本。
- 夜间数据是否存在隐私风险或误转写风险。
- 是否只是本项目云端需要不处理，还是必须要求设备端停止采集。
- 是否愿意维护自定义 OMI App 或固件。

后续建议优先级为：

1. 观察方案 A 是否稳定降低夜间转写、成本和隐私风险。
2. 再评估方案 B：自定义 App 停止上传。
3. 只有明确需要设备端硬件级暂停时，再评估方案 C：固件控制。

## 4. 本项目可能改动点

方案 A 已实施的主要改动位置为：

- `src/handlers/app-connection.ts`
  - 在 WebSocket binary audio 入口判断 quiet hours。
  - 夜间窗口内跳过 `wavWriter.write(audioData)`、`applyVadDecision(audioData)` 和音频队列写入。
  - 已进入 quiet hours 时 finalize 或 close 当前会话。
- `src/services/quiet-hours.ts`
  - 集中读取和判断 quiet hours 配置。
- `tests/unit.ts`
  - 覆盖跨午夜和非跨午夜时间窗口判断。
- `src/index.ts`
  - 暂未增加管理 API，当前通过环境变量控制。
- 数据库 schema
  - 可选增加 quiet hours 抑制统计字段，或复用 `conversations.error_message` / status 记录原因。
- 管理后台
  - 可选增加夜间静音状态展示和开关。

## 5. 暂缓标记

本文件记录研究结论和当前实现状态。当前已实现的是“云端接收侧静音”，不是设备端真正静音。

当前未改变 OMI App 行为、不改固件；设备端和 App 可能仍会采集或上传，只是本项目云端在 quiet hours 内不处理音频。
