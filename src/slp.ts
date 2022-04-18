import { HBCHeader } from './parser';

enum TagType {
	NullTag = 0,
	TrueTag = 1 << 4,
	FalseTag = 2 << 4,
	NumberTag = 3 << 4,
	LongStringTag = 4 << 4,
	ShortStringTag = 5 << 4,
	ByteStringTag = 6 << 4,
	IntegerTag = 7 << 4,
}

const TagMask = 0x70;

export class SerializedLiteralParser {
	private static readonly decoder = new TextDecoder();

	public static parse(buffer: Uint8Array, header: HBCHeader) {
		const result = [];

		let offset = 0;

		while (offset < buffer.length) {
			const tag = buffer[offset++];
			const hasExtendedTag = (tag & 0x80) === 0x80;
			const extendedTag = hasExtendedTag ? buffer[offset++] : 0;
			const count = hasExtendedTag ? (((tag & 0xF) << 8) | extendedTag) : (tag & 0xF);

			const tagType = tag & TagMask;

			for (let i = 0; i < count; i++) {
				switch (tagType) {
				case TagType.NullTag:
					result.push(null);
					break;
				case TagType.TrueTag:
					result.push(true);
					break;
				case TagType.FalseTag:
					result.push(false);
					break;
				case TagType.NumberTag:
					result.push(new Float64Array(buffer.slice(offset))[0]);
					offset += 8;
					break;
				case TagType.LongStringTag:
					result.push(SerializedLiteralParser.getString(header, new Uint32Array(buffer.slice(offset))[0]));
					offset += 4;
					break;
				case TagType.ShortStringTag:
					result.push(SerializedLiteralParser.getString(header, new Uint16Array(buffer.slice(offset))[0]));
					offset += 2;
					break;
				case TagType.ByteStringTag:
					result.push(SerializedLiteralParser.getString(header, buffer[offset++]));
					break;
				case TagType.IntegerTag:
					result.push(new Int32Array(buffer.slice(offset))[0]);
					offset += 4;
					break;
				}
			}
		}
		
		return result;
	}
	private static getString(header: HBCHeader, sid: number) {
		if (sid < 0 || sid > header.header.stringCount) {
			//debugger;
			throw new Error('Invalid string ID');
		}

		const entry = header.stringTableEntries[sid];
		const overflowEntry = header.stringTableOverflowEntries[sid];

		// stringStorage = self.getObj()["stringStorage"]
		// stringTableOverflowEntries = self.getObj()["stringTableOverflowEntries"]

		const overflow = entry.length >= ((1 << 8) - 1);

		const isUTF16 = entry.isUTF16;
		const offset = overflow ? overflowEntry.offset : entry.offset;
		const length = overflow ? overflowEntry.length : entry.length;

		const multiplier = isUTF16 ? 2 : 1; 

		const bytes = header.stringStorage.slice(offset, offset + length * multiplier);
		return isUTF16 ? Buffer.from(bytes).toString('hex') : SerializedLiteralParser.decoder.decode(bytes);
	}
}