# generate_ultra_icon.py
# Generates a distinct, high-tech, futuristic "Zalo Ultra" icon (.png and .ico)
# Designed to be instantly distinguishable from the classic blue Zalo icon on the Windows Taskbar.

import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def create_zalo_ultra_icon():
    size = 512
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Background Squircle (Dark Cyber Obsidian with deep violet/navy undertones)
    padding = 24
    radius = 110
    squircle_box = [padding, padding, size - padding, size - padding]

    # Gradient border: Electric Neon Cyan (#00F2FE) to Deep Cyber Violet (#7F00FF)
    border_width = 12
    
    # Draw soft outer glow
    glow_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_img)
    glow_draw.rounded_rectangle(
        [padding - 6, padding - 6, size - padding + 6, size - padding + 6],
        radius=radius + 4,
        outline=(0, 242, 254, 140),
        width=16
    )
    glow_img = glow_img.filter(ImageFilter.GaussianBlur(12))
    img.paste(glow_img, (0, 0), glow_img)

    # Draw main background container
    draw.rounded_rectangle(
        squircle_box,
        radius=radius,
        fill=(15, 17, 28, 255), # Deep obsidian night
        outline=(0, 242, 254, 255), # Electric Neon Cyan ring
        width=border_width
    )

    # Inner subtle cyber grid/radial highlight
    center_x, center_y = size // 2, size // 2 - 20
    highlight_img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    h_draw = ImageDraw.Draw(highlight_img)
    h_draw.ellipse(
        [center_x - 180, center_y - 180, center_x + 180, center_y + 180],
        fill=(110, 0, 255, 45) # Subtle neon purple ambient glow
    )
    highlight_img = highlight_img.filter(ImageFilter.GaussianBlur(40))
    img.paste(highlight_img, (0, 0), highlight_img)

    # 2. Main Iconic Symbol: Futuristic Bold "Z" & Speech Bubble
    # Draw high-tech sleek "Z" in pure luminous platinum and electric cyan
    z_color = (255, 255, 255, 255)
    cyan_glow = (0, 242, 254, 255)
    gold_color = (255, 195, 0, 255)

    # Draw Speech Bubble tail accent in top right / bottom left
    # Stylized "Z" polygons
    top_bar = [
        (130, 150),
        (382, 150),
        (382, 205),
        (220, 205),
        (130, 150)
    ]
    diag_bar = [
        (340, 195),
        (382, 195),
        (200, 345),
        (130, 345),
    ]
    bottom_bar = [
        (130, 320),
        (292, 320),
        (382, 375),
        (130, 375),
    ]

    # Draw glowing shadow for the Z
    z_shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    zs_draw = ImageDraw.Draw(z_shadow)
    zs_draw.polygon(top_bar, fill=(0, 242, 254, 200))
    zs_draw.polygon(diag_bar, fill=(0, 242, 254, 200))
    zs_draw.polygon(bottom_bar, fill=(0, 242, 254, 200))
    z_shadow = z_shadow.filter(ImageFilter.GaussianBlur(8))
    img.paste(z_shadow, (0, 0), z_shadow)

    # Draw sharp crisp Z
    draw.polygon(top_bar, fill=z_color)
    draw.polygon(diag_bar, fill=(230, 245, 255, 255))
    draw.polygon(bottom_bar, fill=z_color)

    # 3. Supercharged Lightning Bolt (⚡) across the center diagonal
    bolt_pts = [
        (275, 140),
        (225, 250),
        (265, 250),
        (230, 370),
        (300, 240),
        (260, 240)
    ]
    bolt_shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bs_draw = ImageDraw.Draw(bolt_shadow)
    bs_draw.polygon(bolt_pts, fill=(255, 200, 0, 240))
    bolt_shadow = bolt_shadow.filter(ImageFilter.GaussianBlur(10))
    img.paste(bolt_shadow, (0, 0), bolt_shadow)
    draw.polygon(bolt_pts, fill=gold_color, outline=(255, 255, 255, 255))

    # 4. Premium "ULTRA" Badge at bottom center
    badge_w, badge_h = 240, 68
    badge_x = (size - badge_w) // 2
    badge_y = 395
    badge_box = [badge_x, badge_y, badge_x + badge_w, badge_y + badge_h]

    # Badge background (Neon Gradient Pill)
    draw.rounded_rectangle(
        badge_box,
        radius=34,
        fill=(127, 0, 255, 255), # Vivid Purple
        outline=(0, 242, 254, 255), # Neon Cyan rim
        width=4
    )

    # Try loading bold sans font or fallback to default
    font = None
    font_paths = [
        "C:\\Windows\\Fonts\\segoeuib.ttf",
        "C:\\Windows\\Fonts\\arialbd.ttf",
        "C:\\Windows\\Fonts\\calibrib.ttf"
    ]
    for fp in font_paths:
        if os.path.exists(fp):
            try:
                font = ImageFont.truetype(fp, 36)
                break
            except Exception:
                pass
    if font is None:
        font = ImageFont.load_default()

    text = "ULTRA"
    # Calculate text bounding box
    bbox = draw.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = badge_x + (badge_w - tw) // 2
    ty = badge_y + (badge_h - th) // 2 - 3

    # Text shadow
    draw.text((tx + 2, ty + 2), text, font=font, fill=(0, 0, 0, 180))
    # Crisp white text
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))

    return img

def main():
    target_dir = r"C:\Users\phamn\.gemini\antigravity\scratch\zalo-ultra-client"
    os.makedirs(target_dir, exist_ok=True)
    
    png_path = os.path.join(target_dir, "zalo-ultra.png")
    ico_path = os.path.join(target_dir, "zalo-ultra.ico")

    print("[*] Generating Ultra Icon...")
    img = create_zalo_ultra_icon()
    img.save(png_path, "PNG")
    print(f"[+] Saved PNG icon to: {png_path}")

    # Generate multi-resolution .ico (256, 128, 64, 48, 32, 16)
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    img.save(ico_path, format="ICO", sizes=sizes)
    print(f"[+] Saved Multi-Resolution ICO to: {ico_path}")

    # Copy to ZaloApp resources for runtime injection
    env_dist = r"D:\Zalo_Test_Env\ZaloApp\resources\app\pc-dist"
    if os.path.exists(env_dist):
        import shutil
        shutil.copy2(png_path, os.path.join(env_dist, "zalo-ultra.png"))
        shutil.copy2(ico_path, os.path.join(env_dist, "zalo-ultra.ico"))
        # Also backup and update favicon.ico
        shutil.copy2(ico_path, os.path.join(env_dist, "favicon.ico"))
        print(f"[+] Synced icons into ZaloApp runtime: {env_dist}")

if __name__ == "__main__":
    main()
