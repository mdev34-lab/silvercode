import { describe, expect, test } from "bun:test"
import { measureEditText } from "@opentui/core"
import { displayCharAt, displayIndexOf, displaySlice, mentionTriggerIndex, promptOffsetWidth } from "../../src/prompt/display"

describe("prompt display", () => {
  test("promptOffsetWidth matches EditBuffer widthMethod \"unicode\" for tabs and control chars (#372)", () => {
    // Regression: Bun.stringWidth counts tabs and control chars as 0, but the
    // EditBuffer expands tabs to the default tab width and renders control
    // chars in caret notation, so extmarks/cursor after them drifted.
    const cases = [
      "hello world",
      "日本語テキスト",
      "a👍🏽b🎉",
      "ab\ncd",
      "ab\tcd",
      "\t",
      "\t\t",
      "abc\tcd",
      "ab\x01cd",
      "\x01",
      "ab\x1bcd",
      "\x07",
      "a\x00b",
      "a\x7fb",
      "ab\r\ncd",
      "ab\rcd",
      "x\t日本\x01\n👍",
    ]
    for (const value of cases) {
      expect(promptOffsetWidth(value)).toBe(measureEditText(value, { widthMethod: "unicode" }))
    }
    // Anchors for the exact layout numbers, independent of the helper:
    expect(promptOffsetWidth("\t")).toBe(2) // default tab width
    expect(promptOffsetWidth("\x01")).toBe(2) // caret notation ^A
    expect(promptOffsetWidth("ab\ncd")).toBe(5) // one per line break
  })

  test("displayIndexOf stays on display columns with tabs before the token (#372)", () => {
    expect(displayIndexOf("a\tb @bar", "@bar")).toBe(5)
    expect(displayIndexOf("x\x01 @bar", "@bar")).toBe(4)
    const text = "日\t@file.md rest"
    const start = displayIndexOf(text, "@file.md")
    expect(start + promptOffsetWidth("@file.md")).toBe(12)
  })

  test("displaySlice and displayCharAt split on EditBuffer columns with tabs (#372)", () => {
    // a=1, tab=2 => "@bar" starts at column 3
    expect(displaySlice("a\t@bar", 3)).toBe("@bar")
    expect(displayCharAt("a\t@bar", 1)).toBe("\t")
    expect(displayCharAt("a\t@bar", 3)).toBe("@")
  })

  test("displayIndexOf converts UTF-16 indexOf results to display columns (#372)", () => {
    expect(displayIndexOf("foo @bar", "@bar")).toBe(4)
    expect(displayIndexOf("中文 @bar", "@bar")).toBe(5)
    expect(displayIndexOf("🙂 @bar", "@bar")).toBe(3)
    expect(displayIndexOf("👨‍👩‍👧‍👦 @bar", "@bar")).toBe(3)
    expect(displayIndexOf("a\nb @bar", "@bar")).toBe(4)
    expect(displayIndexOf("foo", "@bar")).toBe(-1)
    // The display-column end of a token after wide chars must match the
    // extmark range restoreExtmarksFromParts recreates.
    const text = "中文 @file.md rest"
    const start = displayIndexOf(text, "@file.md")
    expect(start + promptOffsetWidth("@file.md")).toBe(13)
  })
  test("uses display-width offsets for mentions", () => {
    expect(mentionTriggerIndex("@")).toBe(0)
    expect(mentionTriggerIndex("test @")).toBe(5)
    expect(mentionTriggerIndex("中文 @")).toBe(5)
    expect(mentionTriggerIndex("こんにちは @")).toBe(11)
    expect(mentionTriggerIndex("한국어 @")).toBe(7)
    expect(mentionTriggerIndex("🙂 @")).toBe(3)
    expect(mentionTriggerIndex("中文 @src file", Bun.stringWidth("中文 @src"))).toBe(5)
    expect(displayCharAt("中文 @src", Bun.stringWidth("中文 @"))).toBe("s")
    expect(displaySlice("中文 @src", 5, Bun.stringWidth("中文 @src"))).toBe("@src")
    expect(displaySlice("中文 @src", 6, Bun.stringWidth("中文 @src"))).toBe("src")
    expect(mentionTriggerIndex("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe(3)
    expect(displayCharAt("👨‍👩‍👧‍👦 @src", Bun.stringWidth("👨‍👩‍👧‍👦 @"))).toBe("s")
    expect(displaySlice("👨‍👩‍👧‍👦 @src", 3, Bun.stringWidth("👨‍👩‍👧‍👦 @src"))).toBe("@src")
    expect(mentionTriggerIndex("@file1\n@file2", 13)).toBe(7)
    expect(displayCharAt("@file1\n@file2", 6)).toBe("\n")
    expect(displaySlice("@file1\n@file2", 8, 13)).toBe("file2")
    expect(mentionTriggerIndex("@file1\nfoo @file2", 17)).toBe(11)
    expect(mentionTriggerIndex("中文 @one\n@two", 14)).toBe(10)
    expect(displaySlice("中文 @one\n@two", 11, 14)).toBe("two")
    expect(mentionTriggerIndex("中文@")).toBeUndefined()
    expect(mentionTriggerIndex("こんにちは@")).toBeUndefined()
    expect(mentionTriggerIndex("한국어@")).toBeUndefined()
    expect(mentionTriggerIndex("🙂@")).toBeUndefined()
    expect(mentionTriggerIndex("hello@")).toBeUndefined()
    expect(mentionTriggerIndex("foo@bar.com")).toBeUndefined()
    expect(mentionTriggerIndex("中文 @src file")).toBeUndefined()
  })
})
