---
title: Fixture App文档
description: 在iPhone上读取并重写NFC标签上的NDEF记录，所有数据都不会离开设备。
navTitle: 概览
tags:
  - scanning
---

Fixture App把iPhone变成标签读取器和标签写入器。它运行在
苹果向第三方应用开放的NFC硬件上，因此每次只能处理一枚
标签，而且扫描面板必须保持打开。

## Fixture App能做什么

把手机顶边贴在标签上，应用就会解码标签上的NDEF消息。
接下来你可以就地编辑其中一条记录，也可以用新消息覆盖
整枚标签。没有任何内容会被上传，关闭应用之后也不会留
下扫描历史。

读取器可以识别以下负载：
- 文本记录，带有标签声明的语言代码
- URI记录，包括`tel:`和`mailto:`这类快捷形式
- 由Android手机写入的Wi-Fi交接记录
- vCard负载，以联系人卡片的形式显示

写入是*破坏性*的。应用会替换整条NDEF消息，而不是在后
面追加，因此你点按**写入**的那一刻，标签上原有的内容
就没有了。已锁定的标签仍然可以读取，写入器会停下来并
提示`Tag is permanently locked`，而不是报告成功。

## 你需要什么

支持的硬件：iPhone 7或更新机型，运行iOS 16或更高版本。\
支持的标签：已按NDEF格式化的ISO 14443 Type A芯片。

[芯片支持矩阵](reference/chip-support.md)列出了读取器
测试过的每一款芯片，以及每款芯片有多少可写入的存储空
间。NTAG213只有132字节，除了一个短网址之外几乎放不下
别的东西。

:::note[后台扫描]
只有当标签带有与应用关联域名相符的URL记录时，iOS才会
把它交给后台的应用。其他情况都需要在前台打开扫描面板。
:::

::include[safety-note]

---

## 接下来看什么

先看[扫描你的第一个标签](guide/first-tag.md)，那一页在
一枚空白的NTAG215上完成一次读取和一次写入。如果标签完
全读不出来，请先重新核对[你需要什么](#what-you-need)。
多数失败是因为读取器无法寻址那款芯片，而不是标签本身
坏了。

版本号和发行说明在[Fixture App网站](https://example.com/fixture-app)
上。本文档的更正请发送到[docs@example.com](mailto:docs@example.com)。
