import { StringDecoder } from "node:string_decoder";

export type Utf8OutputSink = {
  write(chunk: Buffer): void;
  end(): void;
};

/** Decode each transport independently. Partial UTF-8 is carried until the
 * next packet; only an actual stream end turns an incomplete suffix into �. */
export function createUtf8OutputSink(accept: (bytes: Buffer) => void): Utf8OutputSink {
  const decoder = new StringDecoder("utf8");
  let ended = false;
  const emit = (text: string): void => { if (text.length > 0) accept(Buffer.from(text, "utf8")); };
  return {
    write(chunk) { if (!ended) emit(decoder.write(chunk)); },
    end() { if (!ended) { ended = true; emit(decoder.end()); } },
  };
}
