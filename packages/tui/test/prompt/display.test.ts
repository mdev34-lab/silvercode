import { describe, expect, test } from "bun:test"
import { displayCharAt, displayIndexOf, displaySlice, mentionTriggerIndex, promptOffsetWidth } from "../../src/prompt/display"

describe("prompt display", () => {
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
