import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

def create_base_ultra_icon(size=512):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Outer squircle / rounded rect
    margin = int(size * 0.05)
    radius = int(size * 0.22)
    x0, y0 = margin, margin
    x1, y1 = size - margin, size - margin
    
    # Glow / Neon border layers
    for r in range(int(size * 0.04), 0, -2):
        alpha = int(25 * (1 - r / (size * 0.04)))
        draw.rounded_rectangle([x0 - r, y0 - r, x1 + r, y1 + r], radius=radius + r, fill=(0, 242, 254, alpha))
        
    # Main dark cyber background gradient (Deep Obsidian to Cyber Navy)
    base_box = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d_base = ImageDraw.Draw(base_box)
    for y in range(y0, y1):
        ratio = (y - y0) / (y1 - y0)
        r = int(10 + (22 - 10) * ratio)
        g = int(12 + (18 - 12) * ratio)
        b = int(22 + (48 - 22) * ratio)
        d_base.line([(x0, y), (x1, y)], fill=(r, g, b, 255))
        
    # Mask to rounded rect
    mask = Image.new('L', (size, size), 0)
    d_mask = ImageDraw.Draw(mask)
    d_mask.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=255)
    
    img.paste(base_box, (0, 0), mask)
    
    # Neon Cyan Outer Border
    border_width = max(2, int(size * 0.045))
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, outline=(0, 242, 254, 255), width=border_width)
    
    # Cyber Violet Inner Accent
    inner_m = margin + border_width
    draw.rounded_rectangle([inner_m, inner_m, size - inner_m, size - inner_m], 
                           radius=radius - border_width, 
                           outline=(127, 0, 255, 180), 
                           width=max(1, border_width // 2))
    
    # Draw Bold Modern Stylized 'Z' (Pure White with Crisp Edges)
    zx0 = size * 0.24
    zx1 = size * 0.76
    zy0 = size * 0.20
    zy1 = size * 0.76
    thick = size * 0.125
    
    # Top horizontal bar of 'Z'
    draw.polygon([
        (zx0, zy0),
        (zx1, zy0),
        (zx1 - thick*0.65, zy0 + thick),
        (zx0, zy0 + thick)
    ], fill=(255, 255, 255, 255))
    
    # Diagonal bar of 'Z'
    draw.polygon([
        (zx1, zy0 + thick*0.35),
        (zx1, zy0 + thick*1.05),
        (zx0 + thick*0.65, zy1),
        (zx0, zy1),
        (zx0, zy1 - thick*0.7),
        (zx1 - thick*0.65, zy0)
    ], fill=(245, 250, 255, 255))
    
    # Bottom horizontal bar of 'Z'
    draw.polygon([
        (zx0, zy1 - thick),
        (zx1, zy1 - thick),
        (zx1, zy1),
        (zx0, zy1)
    ], fill=(255, 255, 255, 255))
    
    # Electric Gold Lightning Bolt ⚡ across center
    bolt = [
        (size * 0.54, size * 0.24),
        (size * 0.39, size * 0.51),
        (size * 0.52, size * 0.51),
        (size * 0.44, size * 0.77),
        (size * 0.63, size * 0.45),
        (size * 0.50, size * 0.45),
        (size * 0.59, size * 0.24)
    ]
    # Bolt glow & fill
    draw.polygon(bolt, fill=(255, 215, 0, 255))
    draw.line(bolt + [bolt[0]], fill=(255, 255, 240, 255), width=max(1, int(size * 0.018)))
    
    # 'ULTRA' badge pill at bottom
    bx0 = int(size * 0.24)
    bx1 = int(size * 0.76)
    by0 = int(size * 0.81)
    by1 = int(size * 0.94)
    bradius = int((by1 - by0) / 2)
    draw.rounded_rectangle([bx0, by0, bx1, by1], radius=bradius, 
                           fill=(115, 0, 245, 255), 
                           outline=(0, 242, 254, 255), 
                           width=max(1, int(size * 0.015)))
    
    # Text 'ULTRA' inside badge
    # Try basic font or draw letters manually for crisp rendering
    try:
        font_size = int((by1 - by0) * 0.65)
        font = ImageFont.truetype('arialbd.ttf', font_size)
        bbox = draw.textbbox((0, 0), 'ULTRA', font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
        tx = (size - tw) // 2
        ty = by0 + (by1 - by0 - th) // 2 - bbox[1]
        draw.text((tx, ty), 'ULTRA', font=font, fill=(255, 255, 255, 255))
    except Exception:
        pass
        
    return img

def create_reddot_icon(base_img):
    img = base_img.copy()
    draw = ImageDraw.Draw(img)
    size = img.width
    
    # Red notification dot in top right
    dot_r = int(size * 0.18)
    cx = int(size * 0.81)
    cy = int(size * 0.19)
    
    # Dark border ring around red dot for contrast against any background
    border = max(1, int(size * 0.035))
    draw.ellipse([cx - dot_r - border, cy - dot_r - border, cx + dot_r + border, cy + dot_r + border], 
                 fill=(10, 12, 20, 255))
    # Bright glowing red dot
    draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=(255, 45, 45, 255))
    # Shiny gloss highlight
    hr = int(dot_r * 0.4)
    draw.ellipse([cx - hr, cy - hr - int(dot_r*0.2), cx + int(hr*0.4), cy - int(dot_r*0.1)], 
                 fill=(255, 180, 180, 220))
    return img

def create_busymode_icon(base_img):
    img = base_img.copy()
    draw = ImageDraw.Draw(img)
    size = img.width
    
    dot_r = int(size * 0.18)
    cx = int(size * 0.81)
    cy = int(size * 0.19)
    border = max(1, int(size * 0.035))
    draw.ellipse([cx - dot_r - border, cy - dot_r - border, cx + dot_r + border, cy + dot_r + border], 
                 fill=(10, 12, 20, 255))
    draw.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=(255, 150, 0, 255))
    mw = int(dot_r * 0.6)
    mh = max(1, int(dot_r * 0.22))
    draw.rectangle([cx - mw, cy - mh, cx + mw, cy + mh], fill=(255, 255, 255, 255))
    return img

def main():
    print("Generating High-Resolution Ultra Icon Base (512x512)...")
    base512 = create_base_ultra_icon(512)
    reddot512 = create_reddot_icon(base512)
    busymode512 = create_busymode_icon(base512)
    
    scratch_dir = r"C:\Users\phamn\.gemini\antigravity\scratch\zalo-ultra-client"
    pc_dist_dir = r"D:\Zalo_Test_Env\ZaloApp\resources\app\pc-dist"
    
    # 1. Save in scratch dir
    base512.save(os.path.join(scratch_dir, "zalo-ultra.png"), format="PNG")
    base512.save(os.path.join(scratch_dir, "zalo-ultra.ico"), format="ICO", 
                 sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("Saved scratch icons successfully!")
    
    # 2. Deploy into pc-dist of ZaloApp
    # A. favicon.ico (multi-res)
    base512.save(os.path.join(pc_dist_dir, "favicon.ico"), format="ICO",
                 sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    base512.save(os.path.join(pc_dist_dir, "zalo-ultra.ico"), format="ICO",
                 sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    base512.save(os.path.join(pc_dist_dir, "zalo-ultra.png"), format="PNG")
    
    # B. fav-reddot.ico (with notification dot)
    reddot512.save(os.path.join(pc_dist_dir, "fav-reddot.ico"), format="ICO",
                   sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64)])
    
    # C. fav-busymode.ico
    busymode512.save(os.path.join(pc_dist_dir, "fav-busymode.ico"), format="ICO",
                     sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64)])
    
    # D. favicon-16.ico (16x16)
    base512.resize((16, 16), Image.Resampling.LANCZOS).save(os.path.join(pc_dist_dir, "favicon-16.ico"), format="ICO")
    
    # E. All png sizes in pc-dist
    png_sizes = {
        "favicon-32x32.png": (32, 32),
        "favicon-96x96.v1.png": (96, 96),
        "favicon-128x128.png": (128, 128),
        "favicon-144x144.png": (144, 144),
        "favicon-256x256.png": (256, 256),
        "favicon-512x512.png": (512, 512),
        "android-icon-192x192.png": (192, 192),
        "apple-icon-180x180.png": (180, 180),
        "apple-icon-152x152.png": (152, 152),
        "apple-icon-144x144.png": (144, 144),
        "apple-icon-120x120.png": (120, 120),
        "apple-icon-114x114.png": (114, 114)
    }
    for filename, s in png_sizes.items():
        base512.resize(s, Image.Resampling.LANCZOS).save(os.path.join(pc_dist_dir, filename), format="PNG")
        
    print(f"Successfully generated and replaced ALL {len(png_sizes) + 5} icon assets in pc-dist!")

if __name__ == '__main__':
    main()
