---
title: 芯片支持矩阵
description: Fixture App在iOS上能读、能写哪些NFC芯片，以及每一款各自的注意事项。
navTitle: 芯片支持
tags:
  - chips
---

Fixture App通过Core NFC与标签通信，所以一款芯片只有以
iOS开放的标签类型之一来应答时才能用：ISO 14443A上的
Type 2、ISO 7816上的Type 4，或者ISO 15693上的Type 5。
只在私有协议上应答的芯片，只会显示成一个标识符，再没
有别的。

下面的每一条结果，都来自运行iOS 18.2的iPhone 13和
iPhone 15 Pro，测试对象是三家供应商的空白标签。“读取”
指扫描面板不需要额外设置就能把NDEF消息从标签上取下来。
“写入”指写入面板把一条新消息写回去，并在之后报告剩余
的空闲字节。用户存储空间指NDEF消息可以占用的空间，它
总是小于芯片本身的总存储容量。

::include[legend]

:::table[按芯片划分的Core NFC支持情况，在iOS 18.2上实测]
| 芯片 | 器件编号 | 读取 | 写入 | 用户存储空间（字节） |
| :--- | --- | :---: | --- | ---: |
| NTAG213 | `NT2H1311` | ✅ | ✅ | 144 |
| NTAG215 | `NT2H1511` | ✅ | ✅ | 504 |
| NTAG216 | `NT2H1611` | ✅ | ✅ | 888 |
| [NTAG424 DNA](https://example.com/chips/nt4h2421gx) | `NT4H2421Gx` | ✅ | ⚠️ | 416 |
| MIFARE Ultralight EV1 | `MF0UL1101` | ✅ | ✅ | 48 |
| MIFARE Ultralight C | `MF0ICU2` | ✅ | ⚠️ | 144 |
| ICODE SLIX2 | `SL2S2602` | ✅ | ⚠️ | 316 |
| [MIFARE DESFire EV3](https://example.com/chips/mf3d8x3) | `MF3D8X3` | ⚠️ | ❌ | — |
| MIFARE Classic 1K | `MF1S503x` | ❌ | — | — |
:::

## 这些注意事项是什么意思

“写入”列里的⚠️表示该芯片要多走一步才接受写入，绝不是
说写入一旦开始就不可靠。

NTAG424 DNA出厂时NDEF文件被AES认证锁着，所以写入面板
会先要应用密钥，然后才改动任何内容。Ultralight C在计
数器以上的页面用3DES，除非你把密钥粘贴进“设置”里的
“高级”“标签密钥”，否则Fixture App只在锁定字节以下写
入。ICODE SLIX2在ISO 15693上应答，并以四字节为一块存
储消息，所以空闲字节数是按四递减的。

DESFire EV3只能读，仅此而已。手机可以选中NDEF应用并读
出里面的内容，但创建文件或调整文件大小需要一把我们不
会让你随身带着的密钥，所以写入按钮一直是灰的，并显示
“此标签在iPhone上是只读的”。MIFARE Classic 1K则完全读
不了。iOS交回标识符就到此为止，扫描面板会报告错误
2001，“标签不符合NDEF规范”。这两款芯片在存储空间列里
都没有数字：DESFire的大小在文件创建时就定死了，而
Classic上根本没有可测量的NDEF文件。

## 如果某款芯片不在表里

把扫描面板里的标签标识符和包装上印的标记发到
[docs@example.com](mailto:docs@example.com)，我们会去
测。表上有的芯片，隔着一个带金属片的手机壳或者一张银
行卡，照样可能失败，这一点在[扫描不成功时](../guide/troubleshooting.md)
里有讲。
