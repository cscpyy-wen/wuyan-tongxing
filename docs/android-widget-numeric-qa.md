# 数字小组件验收记录

日期：2026-09-20。设备：本机 `emulator-5554`，Android 16 / API 36，1280×2856，480 dpi。

## 交付行为

- 2×2 圆角数字卡片：大数字为当前计划今日支数，小数字为距上一支的 `分:秒` / `时:分:秒`。没有说明文字、固定成功文案或成功 Toast。
- 整张卡片点击记录一支和时间。失败时保留系统提示，避免误以为已保存。
- 按北京时间统计，主状态与两个原生待合并队列按 UUID 去重；编辑、删除、合并及控制中心记录会触发更新。
- 计时使用桌面宿主中的 Android Chronometer，不依赖 App 常驻。暂无记录时显示 `0` 与 `—:—`；数据暂不可用时不伪造数字。
- 浅色为浅绿白底、深绿数字，深色为深绿底、浅色数字；字体自动缩放。

## 验证结果

- `pnpm test:android:native:device`，指定 `ANDROID_SERIAL=emulator-5554`：原生构建/JVM 门禁及 instrumentation **38/38 通过**。
- 新增测试覆盖主状态/两个队列去重、连续 12 次点击逐次增加、合并确认前后数字不变、北京时间跨日、历史尝试隔离、编辑/删除/同意撤回/损坏、重启计时基准与时间回拨、真实 RemoteViews/Chronometer 渲染。
- `node --test scripts/android-device-test-results.test.mjs scripts/release-gate.test.mjs`：**10/10 通过**。
- 最终布局微调后 `:app:assembleDebug` 与 `:app:lintDebug` 通过；`git diff --check` 通过。
- 实际桌面点击：`0 → 1 → 4`；打开 App 合并后仍为 4，四条均无原因/烟瘾强度。
- App 内新增一条：桌面自动变成 5；撤销该条测试记录：桌面自动回到 4，并恢复上一条记录的计时。
- 覆盖安装最终间距调整版后数据保留；浅色、深色、1.5 倍字号下无截断。结束后台 App 进程后点击，数字由 4 增至 5。
- 计时在桌面实际从 `03:55` 推进到 `04:05`，新点击后回到 `00:01`。原生崩溃日志检查未发现异常。

模拟器截图保存在本机忽略目录 `.toolchains/widget-qa/`：`widget-light-final.png`、`widget-dark-final.png`、`widget-dark-large-font.png`。

## APK

- 路径：`apps/android-shell/android/app/build/outputs/apk/debug/app-debug.apk`
- 大小：10,181,688 字节
- SHA-256：`19FDF5F71B515EFE776D63301BFB706EA45669E6A3DB5B342CC229C882B3FD56`
- 本次为独立包名的 debug 候选，可覆盖之前同签名的测试版。未公开发布新版 Release。

## 设备边界

本次为 Android 模拟器验证；小米 15 Pro / HyperOS 3 的实际桌面圆角裁剪、网格和后台调度仍以手机结果为准。午夜日期刷新采用不唤醒设备的普通闹钟及系统广播，并保留 30 分钟兜底更新；深度休眠或系统限制时，跨日支数刷新可能延迟。旧小组件可随升级更新，若原尺寸不合适可重新添加 2×2 卡片。删除的是模拟器里专门新增的一条测试记录，没有操作用户手机数据。
