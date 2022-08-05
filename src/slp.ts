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
	/*
	public static parse(buffer: Uint8Array, header: HBCHeader) {
		const dv = new DataView(buffer.buffer);

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
					result.push(dv.getFloat64(offset, true));
					offset += 8;
					break;
				case TagType.LongStringTag:
					result.push(SerializedLiteralParser.getString(header, dv.getUint32(offset, true)));
					offset += 4;
					break;
				case TagType.ShortStringTag:
					result.push(SerializedLiteralParser.getString(header, dv.getUint32(offset)));
					offset += 2;
					break;
				case TagType.ByteStringTag:
					result.push(SerializedLiteralParser.getString(header, buffer[offset++]));
					break;
				case TagType.IntegerTag:
					result.push(dv.getInt32(offset, true));
					offset += 4;
					break;
				}
			}
		}
		
		return result;
	}
*/
	public static parseN(buffer: DataView, header: HBCHeader, initialOffset: number, itemCount: number) {
		const data = new DataView(buffer.buffer, initialOffset);

		const result = [];

		let offset = 0;

		while (offset < data.byteLength) {
			const tag = data.getUint8(offset++);
			const hasExtendedTag = (tag & 0x80) === 0x80;
			const extendedTag = hasExtendedTag ? data.getUint8(offset++) : 0;
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
					result.push(data.getFloat64(offset, true));
					offset += 8;
					break;
				case TagType.LongStringTag:
					result.push(SerializedLiteralParser.getString(header, data.getUint32(offset, true)));
					offset += 4;
					break;
				case TagType.ShortStringTag:
					result.push(SerializedLiteralParser.getString(header, data.getUint16(offset, true)));
					offset += 2;
					break;
				case TagType.ByteStringTag:
					result.push(SerializedLiteralParser.getString(header, data.getUint8(offset++)));
					break;
				case TagType.IntegerTag:
					result.push(data.getInt32(offset, true));
					offset += 4;
					break;
				}

				if (result.length >= itemCount) {
					return result;
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

		// stringStorage = self.getObj()["stringStorage"]
		// stringTableOverflowEntries = self.getObj()["stringTableOverflowEntries"]

		const overflow = entry.length >= ((1 << 8) - 1);

		const isUTF16 = entry.isUTF16;
		const offset = overflow ? header.stringTableOverflowEntries[entry.offset].offset : entry.offset;
		const length = overflow ? header.stringTableOverflowEntries[entry.offset].length : entry.length;

		const multiplier = isUTF16 ? 2 : 1; 

		const bytes = header.stringStorage.slice(offset, offset + length * multiplier);
		return isUTF16 ? Buffer.from(bytes).toString('hex') : SerializedLiteralParser.decoder.decode(bytes);
	}
}