# braces 3.0.3 本地深度防护补丁

核对日期：2026-10-22。对应公告：[GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)。

这是本项目维护的代码补丁，不是上游发布。核对时 npm 最新版本仍为 3.0.3，公告的已修复版本为 None；上游的 [PR 78](https://github.com/micromatch/braces/pull/78) 与 [PR 88](https://github.com/micromatch/braces/pull/88) 均未合并。原始 npm/OSV 告警与规范身份 `pkg:npm/braces@3.0.3` 必须继续保留，不能将补丁写成 3.0.4、改名或隐藏 PURL 来让公告消失。

## 来源与归属

- 原包：[npm braces 3.0.3](https://registry.npmjs.org/braces/3.0.3)。
- 原始制品：[braces-3.0.3.tgz](https://registry.npmjs.org/braces/-/braces-3.0.3.tgz)，13,972 字节。
- 上游源码与测试：[固定提交 74b2db2938fad48a2ea54a9c8bf27a37a62c350d](https://github.com/micromatch/braces/tree/74b2db2938fad48a2ea54a9c8bf27a37a62c350d)，对应 3.0.3 标签。
- 许可：MIT，`Copyright (c) 2014-present, Jon Schlinkert.` 原包 LICENSE 与 package.json 未修改。回归文件内嵌的上游测试源保留完整 MIT 许可及原文件中的归属注释。
- 本项目只添加本节所述的深度防护和验证，不代表上游作者认可或审阅该补丁。

原始 tarball SHA-256：

```text
1cd18e862c8640b4568b1425a7df4ee030ff201d45b2da8f9f222d2987494ffc
```

原始 tarball SHA-512 integrity（与锁定来源一致）：

```text
sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==
```

## 实际修改

[补丁文件](../../patches/braces@3.0.3.patch)只改五个文件，共新增 25 行、删除 6 行：

| 文件 | 改动 |
| --- | --- |
| `lib/utils.js` | 增加统一的 `assertDepth`，超过 100 时抛出带 `ERR_BRACES_DEPTH` 的 `SyntaxError` |
| `lib/parse.js` | 在创建花括号和圆括号容器前检查栈深度，防止深层字符串进入递归遍历 |
| `lib/compile.js` | 递归访问每个节点时检查实际调用深度，覆盖直接传入的 AST |
| `lib/stringify.js` | 同样检查实际递归深度，包括直接传入的 AST |
| `lib/expand.js` | 检查递归深度，并分别限制两处 parent 链遍历，避免循环 parent 导致无限循环 |

限制不受 `maxDepth`、`maxLength` 或其他选项提高。深层与循环 AST 会在有限次数的调用后受控拒绝；共享但无环的节点仍被允许。引号、转义和方括号内按字面量处理的括号不增加解析容器深度。

### 100 的准确含义

解析器统计嵌套容器；遍历器从根节点的 0 开始统计递归调用，并计入实际访问的终端节点。两者不是相同的计数，不能笼统承诺“所有 100 层模式都通过”。

| 输入 | parse | compile / stringify | expand |
| --- | --- | --- | --- |
| 99 层花括号包围 `x` | 通过 | 通过 | 通过 |
| 100 层花括号包围 `x` | 通过 | 终端节点达到深度 101，拒绝 | 该输入通过；文本分支未再递归 |
| 101 层花括号包围 `x` | 拒绝 | 在解析时拒绝 | 在解析时拒绝 |
| 直接传入的空 root 链，最深节点深度 100 | 不适用 | 通过 | 通过 |
| 同一 AST 最深节点深度 101 | 不适用 | 拒绝 | 拒绝 |

默认 `braces()` 与 `braces.create()` 走 compile 分支时遵循 compile 的限制。合法但过深的输入被拒绝，是本补丁有意引入的兼容性变化。

## 离线复验

依赖安装完成后执行：

```powershell
node --test --test-reporter=tap scripts/security-patches/braces.test.cjs
```

发布门禁可用 `WUYAN_SECURITY_PATCH_PACKAGE_PATH` 指定每一份实际安装的 braces 包目录。未指定时从安装图中的 micromatch 解析。被测修补实现直接从该目录加载；测试不会生成或代替安装包，不联网，不修改 node_modules。

```powershell
$env:WUYAN_SECURITY_PATCH_PACKAGE_PATH = '要验证的 braces 包绝对目录'
node --test --test-reporter=tap scripts/security-patches/braces.test.cjs
```

测试先校验补丁哈希和完整包内文件集合，再逆向应用该补丁，并将全部十个原始文件哈希与固定来源比对。原版负对照才使用内存中逆向还原的模块；正向测试和攻击回归使用实际安装的修补文件。构建此次证据时，另已对官方 tarball 在内存中解包，确认其全部十个文件与测试中固定的原始哈希逐项相同。

本轮 Node 24.14.1 实跑结果：**807 项通过，0 失败、0 跳过、0 取消、0 todo，约 8.2 秒**。其中包括：

- 固定上游提交的全部 12 份测试源，逐份校验 Git blob，按原文件逻辑注册的 764 项用例均通过；无需安装 Mocha 或调用 Bash。
- 1,239 项普通语法与选项组合，对照原版输出或错误；保留集合、范围、转义、引号、空值及 rangeLimit 语义。
- 16 类深层与循环输入：4,000 层字符串、12,000 层直接 AST、子节点循环、混合容器与 parent 循环；每项均有原版负对照。
- 解析和 AST 的深度边界、选项不能放宽上限、字面量括号及共享无环节点。

攻击子进程使用 512 KiB 栈、128 MiB 堆和 2.5 秒超时。原版表现为接受深层解析输入、栈溢出或 parent 循环超时；修补版全部以预期错误码拒绝。测试运行器的原版基线检查明确验证这些差异，不把超时当成修补版通过。

## 补丁与制品绑定

- 补丁 SHA-256：`6fd0203dc23690cde48857c39c94d8a237e8b5f588339645b1c02851d234f4a9`
- 回归入口 SHA-256：`faca0754c4769611a035af6450a7398b2dae0de676a5e5d00c0b6c4c1d4cd66a`
- 回归入口：[scripts/security-patches/braces.test.cjs](../../scripts/security-patches/braces.test.cjs)

下列清单来自正式 pnpm 补丁安装，不包含 node_modules；保持原有十个文件，没有隐藏额外代码：

| 相对路径 | SHA-256 |
| --- | --- |
| `index.js` | `332ea07c7b006361aad12aa994ca75dc1db8e8382b884909e2f38f10b85c88a4` |
| `lib/compile.js` | `88cf20f18b59c9b2741c2d9b0f0ac6b2967d8e174667edf817133ca57d76809e` |
| `lib/constants.js` | `c18ac5adb57308f1ce42a28552da3a31f5d83709743ebd9a636336813a744d4b` |
| `lib/expand.js` | `c0e6923f3e5aab16d189676c5b82481bb7d2c4a57b5228ad2f1c9ca66b0f912a` |
| `lib/parse.js` | `adf3c108a16afaabe5379298d2227881e88f536cc7345b7df780a80d38dd01f9` |
| `lib/stringify.js` | `a3b8b5e7567ff9bfdbe155479fbdd92d5a924c3919adf05316f8f0c4f6330332` |
| `lib/utils.js` | `3874b7db6934be091aa204554f29dbd988b441f6f16b7c202e08069de6b6c35d` |
| `LICENSE` | `35bdd8a44339719441900fb50fbefc5e2dca1ca662cbaed7a687de842c8b70f2` |
| `package.json` | `56f08b888a4f30dc7cf8a7dbb36ffe92b737912ba36abe9d069d32167c957ac7` |
| `README.md` | `947b0fc3cc12eaaa070207126213fbdf9ab2bf8cd13dcc6e4007b36b79309866` |

复算清单和入口哈希：

```powershell
node scripts/security-patches/braces.test.cjs --inventory
```

这份文档是补丁证据，不是免查白名单。发布判断必须重新核对锁文件、原始来源、补丁、全部实际安装副本和回归程序，并运行测试。未知公告、哈希变化、补丁未应用或测试失败应阻止发布；SBOM 必须仍以未带 patch_hash 后缀的上游版本查询公告。

## 仍未覆盖的边界

本补丁针对解析器产生的深层树、直接 AST 的递归节点链和 expand 的 parent 链。它不限制所有浅层笛卡尔积展开、生成正则的运行成本或总输出大小；现有 rangeLimit 也不是总资源预算。任意畸形 AST 字段（例如嵌套数组形式的 text.value）、getters/proxies、调用者主动篡改导出的内部工具等，不在此次安全证明范围内。

`SyntaxError` 仍需要调用方正确处理；未捕获异常仍可能结束调用进程，因此不能把受控拒绝等同于所有网络服务均具备容错。本仓库的全项目构建、端到端、原生与最终发布验证仍须单独完成。这些测试不会撤销原始公告，也不能证明不存在其他漏洞。
