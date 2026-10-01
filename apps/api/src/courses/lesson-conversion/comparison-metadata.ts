import type { LessonBlock, LessonContent } from '@aivirteach/lesson-blocks';

type ConversionShape = { content: LessonContent; report: unknown[]; dropped: string[] };
type GeneratedTextByBlockId = Readonly<Record<string, readonly string[]>>;

const generatedTextByResult = new WeakMap<object, GeneratedTextByBlockId>();

export function storeConversionComparisonMetadata(result: ConversionShape, generatedText: GeneratedTextByBlockId): void {
  generatedTextByResult.set(result, generatedText);
}

export function getConversionComparisonMetadata(result: ConversionShape): GeneratedTextByBlockId {
  return generatedTextByResult.get(result) ?? {};
}

export function withoutGeneratedComparisonText(
  content: LessonContent,
  ignoredTextByBlockId: GeneratedTextByBlockId,
): LessonContent {
  return {
    ...content,
    blocks: content.blocks.map((block) => {
      const ignoredText = ignoredTextByBlockId[block.id];
      if (!ignoredText?.length || typeof block.props !== 'object' || block.props === null) return block;
      const props = block.props as Record<string, unknown>;
      const textProperty = block.type === 'paragraph' ? 'text' : block.type === 'image' ? 'alt' : undefined;
      if (!textProperty || typeof props[textProperty] !== 'string') return block;
      const comparableText = ignoredText.reduce((value, ignored) => value.replace(ignored, ''), props[textProperty] as string);
      return { ...block, props: { ...props, [textProperty]: comparableText } } as LessonBlock;
    }),
  };
}
