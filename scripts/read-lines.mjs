import { StringDecoder } from 'node:string_decoder';

/** Split newline-delimited files only on LF; U+2028/U+2029 are valid JSON string data. */
export async function* readLfLines(input) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  for await (const chunk of input) {
    buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let start = 0;
    while (true) {
      const end = buffer.indexOf('\n', start);
      if (end < 0) break;
      let line = buffer.slice(start, end);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      yield line;
      start = end + 1;
    }
    buffer = buffer.slice(start);
  }
  buffer += decoder.end();
  if (buffer.length) {
    if (buffer.endsWith('\r')) buffer = buffer.slice(0, -1);
    yield buffer;
  }
}
