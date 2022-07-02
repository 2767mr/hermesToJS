export class Reader {
	private currentByte = 0;
	private bitCount = 0;
	private position = 0;

	public constructor(
        private readonly input: Uint8Array
	) { }

	public get bitCounter() {
		return this.bitCount;
	}

	private readBit(remaining?: number) {
		if (!this.bitCount) {
			const a = this.readByte();
			if (a !== undefined)
				this.currentByte = a;
			this.bitCount = 8;
		}

		if (remaining !== undefined) {
			return (this.currentByte & (1 << remaining-1)) >> remaining-1;
		}

		const result = (this.currentByte & (1 << this.bitCount-1)) >> this.bitCount-1;
		this.bitCount -= 1;
		return result;
	}

	private clearBits(remaining: number){
		this.bitCount -= remaining;
		this.currentByte = this.currentByte >> remaining;
	}

	private readByte() {
		const result = this.input[this.position];
		this.position++;
		return result;
	}

	public readBits(n: number, remained?: boolean) {
		let result = 0;
		for (let i = n; i > 0; i -= 1) {
			result = (result << 1) | this.readBit(remained ? i : undefined);
		}
        
		if (remained) {
			this.clearBits(n);
		}
        
		return result;
	}
    
	public readBytes(n = 1) {
		let result = 0;
		for (let i = n; i > 0; i--) {
			result = (result << 8) | this.readByte();
		}
		return result;
	}

	public readSlice(n: number) {
		const a = this.input.slice(this.position, this.position + n);
		this.position += n;
		return a;
	}

	public seek(i: number) {
		this.position = i;
	}
    
	public tell() {
		return this.position;
	}

	public pad(alignment: number) {
		if (this.position % alignment == 0)
			return;

		const offset = alignment - (this.position % alignment);
		this.position += offset;
	}
    
	public readAll() {
		const a = new Uint8Array(this.input).buffer.slice(this.position);
		this.position += a.byteLength;
		return a;
	}
}