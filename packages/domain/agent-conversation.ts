export type ConversationIntent = 'greeting' | 'current_time' | 'capabilities';

/** Match the whole message so business text and private suffixes never enter conversation routing. */
export function classifyConversationIntent(content: string): ConversationIntent | null {
  const text = content.trim().toLowerCase();
  if (/^(?:你好|您好|嗨|hi|hello)[！!。.?？]*$/.test(text)) return 'greeting';
  if (
    /^(?:请问|请告诉我|告诉我)?(?:当前北京时间(?:是多少|是什么)?|(?:现在|当前)(?:的)?北京时间(?:是)?(?:多少|几点)?|现在(?:是)?几点(?:了|钟)?|今天(?:的)?日期(?:是(?:什么|多少))?|今天是几月几(?:号|日)|今天(?:是)?几号)[？?。！!]*$/.test(
      text,
    )
  )
    return 'current_time';
  if (
    /^(?:请问|请告诉我|告诉我)?(?:你能做什么|你可以做什么|你有哪些功能|你有什么功能|你支持哪些功能|介绍一下你的功能|介绍一下你的能力)[？?。！!]*$/.test(
      text,
    )
  )
    return 'capabilities';
  return null;
}
