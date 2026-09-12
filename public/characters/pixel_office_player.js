export class PixelOfficeCharacter {
  constructor(imgUrl, meta, scale = 3) {
    this.image = new Image();
    this.image.src = imgUrl;
    this.meta = meta;
    this.scale = scale;
    this.animation = "idle";
    this.frame = 0;
    this.elapsed = 0;
  }

  setAnimation(name) {
    if (!this.meta.animations[name]) throw new Error(`Unknown animation: ${name}`);
    if (this.animation !== name) {
      this.animation = name;
      this.frame = 0;
      this.elapsed = 0;
    }
  }

  update(dtMs) {
    const a = this.meta.animations[this.animation];
    const frameMs = 1000 / a.fps;
    this.elapsed += dtMs;
    while (this.elapsed >= frameMs) {
      this.elapsed -= frameMs;
      this.frame++;
      if (this.frame >= a.frames) {
        this.frame = a.loop ? 0 : a.frames - 1;
      }
    }
  }

  draw(ctx, x, y) {
    const a = this.meta.animations[this.animation];
    const sx = this.frame * this.meta.frameWidth;
    const sy = a.row * this.meta.frameHeight;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.image,
      sx, sy, this.meta.frameWidth, this.meta.frameHeight,
      x, y,
      this.meta.frameWidth * this.scale,
      this.meta.frameHeight * this.scale
    );
  }
}

// Uso:
// const meta = await fetch("./alex/alex.json").then(r => r.json());
// const alex = new PixelOfficeCharacter("./alex/alex_spritesheet.png", meta, 4);
// alex.setAnimation("walk");