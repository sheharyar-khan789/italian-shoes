"""Builds demo-catalog/products.json (names, sizes, colours, descriptions, PKR demo prices, reference prices)
from the image entries already in products.json. Run: python demo-catalog/tools/build-products.py"""
import json, os
base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..") + os.sep
old = {x["slug"]: x for x in json.load(open(base + "products.json", encoding="utf-8"))["products"]}
NOTICE = " Demonstration product for testing this store: not a real offer. The brand name only identifies the model shown; this store is not affiliated with or authorised by {b}."
M = ["41", "42", "43", "44"]
W = ["37", "38", "39", "40"]
K = ["30", "31", "32", "33"]


COUNT = [0]


def P(slug, name, brand, cat, color, hexv, sizes, sell, ref, desc, feat=False, new=False):
    COUNT[0] += 1
    return {"slug": slug, "name": name, "brand": brand, "category": cat, "sku": "DEMO-%s-%02d" % (brand[:3].upper(), COUNT[0]),
            "colorName": color, "colorHex": hexv, "sizes": sizes, "stockPerSize": 3, "description": desc + NOTICE.format(b=brand),
            "sellPKR": sell, "refPrice": ref, "featured": feat, "isNewArrival": new, "image": old[slug]["image"]}


def R(amount, cur, kind, url, note):
    return {"amount": amount, "currency": cur, "kind": kind, "sourceUrl": url, "note": note}


usd = "Reference = list price on the brand's US site as seen in search results. The PKR price is an ESTIMATED demo price (about Rs 280 per US dollar, rounded), not a Pakistani retail price."
eur = "Reference = a retailer's regular price in euros (not Reebok's own price). The PKR price is an ESTIMATED demo price (about Rs 305 per euro, rounded), not a Pakistani retail price."
L = [
    P("nike-air-force-1-07", "Nike Air Force 1 '07", "Nike", "Men's Sneakers", "White", "#f4f4f2", M, 32000,
      R(115, "USD", "official", "https://www.nike.com/w/mens-air-force-1-shoes-5sj3yznik1zy7ok", usd),
      "Low-top sneaker with a leather upper and Nike Air cushioning in the sole, shown in all white. A basketball-heritage style from 1982.", True),
    P("air-jordan-1", "Air Jordan 1 High", "Nike", "Men's Sneakers", "White / Red / Black", "#b3202a", M, 52000,
      R(185, "USD", "official", "https://www.nike.com/t/air-jordan-1-retro-high-og-womens-shoes-p9471nPP", usd + " Reference is the Air Jordan 1 Retro High OG list price."),
      "High-top leather sneaker in a white, red and black colourway with the Air Jordan wings logo on the collar and a Nike swoosh on the side."),
    P("air-jordan-4", "Air Jordan 4", "Nike", "Men's Sneakers", "White / Cement Grey", "#cfd0d2", M, 61500,
      R(220, "USD", "official", "https://www.nike.com/t/air-jordan-4-retro-mens-shoes-OpWLafSW", usd + " Reference is the Air Jordan 4 Retro list price."),
      "Mid-cut sneaker in white with grey speckled accents, mesh side panels and a visible Air unit in the heel.", True),
    P("nike-dunk-low", "Nike Dunk Low", "Nike", "Men's Sneakers", "Grey / Red", "#b0242c", M, 33500,
      R(120, "USD", "official", "https://www.nike.com/t/dunk-low-retro-mens-shoes-5FQWGR", usd + " Nike lists Dunk Low Retro at about $115-120."),
      "Low-top leather sneaker in grey and red with a white midsole. The Dunk was first introduced as a basketball shoe in the 1980s.", False, True),
    P("converse-chuck-taylor-all-star-classic-black", "Converse Chuck Taylor All Star High Top", "Converse", "Men's Sneakers", "Black", "#1a1a1a", M, 18000,
      R(65, "USD", "official", "https://www.converse.com/shop/p/chuck-taylor-all-star-canvas-unisex-high-top-shoe/M9006MP.html", usd),
      "Classic canvas high-top in black with white laces, the All Star ankle patch and a white rubber toe cap and midsole."),
    P("converse-chuck-taylor-all-star-leather", "Converse Chuck Taylor All Star Leather High Top", "Converse", "Men's Sneakers", "Triple Black", "#0f0f0f", M, 19500,
      R(70, "USD", "official", "https://www.converse.com/shop/p/chuck-taylor-all-star-leather-unisex-high-top-shoe/135251MP.html", usd),
      "High-top with a leather upper in all black, black laces and a black rubber sole."),
    P("reebok-glide-ripple-clip", "Reebok Glide Ripple Clip", "Reebok", "Men's Sneakers", "Black", "#1a1a1a", M, 18500,
      R(60.95, "EUR", "retailer", "https://runforest.com/en-ie/products/reebok-reebok-royal-glide-ripple-clip-ftwwht-vecnav-pugry4", eur),
      "Retro-inspired low-top trainer in black with a leather-look upper and a ripple-pattern rubber outsole."),
    P("asics-gel-cumulus-22", "ASICS Gel-Cumulus 22", "ASICS", "Running Shoes", "Graphite / Lime", "#4a5058", M, 33500,
      R(120, "USD", "official", "https://www.asics.com/us/en-us/gel-cumulus-22/p/ANA_1011A862-020.html", usd + " ASICS US shows $120 as the original price."),
      "Neutral road-running shoe with a mesh upper and GEL cushioning in the heel, shown in graphite grey with lime accents."),
    P("converse-chuck-taylor-all-star-womens", "Converse Chuck Taylor All Star High Top (Women's)", "Converse", "Women's Shoes", "Black / Cream", "#2a2622", W, 19500,
      R(70, "USD", "indicative", "https://www.converse.com/shop/p/chuck-taylor-all-star-womens-high-top-shoe/A07118MP.html", usd + " The exact price was not confirmed; Converse Chuck Taylor high tops were seen at $65-$70."),
      "Women's canvas high-top in black with cream laces and midsole, a red heel tab and soft pink detailing."),
    P("converse-chuck-taylor-all-star-lift-platform-womens", "Converse Chuck Taylor All Star Lift Platform (Women's)", "Converse", "Women's Shoes", "Black / White", "#222222", W, 22500,
      R(80, "USD", "official", "https://www.converse.com/shop/p/chuck-taylor-all-star-lift-platform-canvas-womens-high-top-shoe/560845MP.html", usd),
      "Canvas high-top on a raised platform sole, in black with white laces and a white rubber toe cap.", True),
    P("converse-chuck-taylor-all-star-lift-leather-womens", "Converse Chuck Taylor All Star Lift Platform Leather Low Top (Women's)", "Converse", "Women's Shoes", "White", "#f4f4f2", W, 22500,
      R(80, "USD", "official", "https://www.converse.com/shop/p/chuck-taylor-all-star-lift-platform-leather-womens-low-top-shoe/561681MP.html", usd),
      "Low-top leather sneaker with a double-stacked platform sole, in white with a black stripe."),
    P("asics-gel-kayano-26-womens", "ASICS Gel-Kayano 26 (Women's)", "ASICS", "Women's Shoes", "Black / White", "#262626", W, 45000,
      R(160, "USD", "official", "https://www.asics.com/us/en-us/gel-kayano-26/p/ANA_1012A457-001.html", usd + " ASICS US listed $160 as the original price of this earlier model."),
      "Stability running shoe with GEL cushioning and a FlyteFoam midsole, in black and white.", True),
    P("asics-gel-nimbus-28-womens", "ASICS Gel-Nimbus 28 (Women's)", "ASICS", "Women's Shoes", "Pale Pink", "#f0cfc2", W, 47500,
      R(170, "USD", "official", "https://www.asics.com/us/en-us/gel-nimbus-28/p/ANA_1012B899-700.html", usd + " ASICS US lists $170 as the original price."),
      "Cushioned neutral running shoe with a thick foam midsole and a breathable upper, shown in pale pink.", False, True),
    P("air-jordan-4-retro-shes-a-star-big-kids", "Air Jordan 4 Retro \"She's A Star\" (Big Kids)", "Nike", "Kids' Shoes", "Rose Pink", "#b2305f", K, 46000,
      R(165, "USD", "official", "https://www.nike.com/t/air-jordan-4-retro-shes-a-star-big-kids-shoes-g0maqmm7/IO2829-600", usd),
      "Big-kids' version of the Air Jordan 4 in rose pink with black speckled panels, blue accents and a visible Air unit in the heel."),
    P("converse-chuck-taylor-all-star-little-kids", "Converse Chuck Taylor All Star High Top (Little Kids)", "Converse", "Kids' Shoes", "Triple Black", "#0f0f0f", K, 11000,
      R(40, "USD", "official", "https://www.converse.com/shop/p/chuck-taylor-all-star-canvas-little-kids-high-top-shoe/3S121_115.html", usd),
      "Little-kids' canvas high-top in all black with black laces and the All Star ankle patch.", True),
    P("converse-chuck-taylor-all-star-easy-on-little-kids", "Converse Chuck Taylor All Star Easy-On (Little Kids)", "Converse", "Kids' Shoes", "White", "#f4f4f2", K, 13000,
      R(47, "USD", "official", "https://www.converse.com/shop/p/chuck-taylor-all-star-easy-on-little-kids-high-top-shoe/372884F_020.html", usd),
      "Little-kids' white canvas high-top with an easy-on strap instead of laces, with red and navy stripe detail."),
    P("asics-gel-noosa-tri-16-grade-school", "ASICS Gel-Noosa Tri 16 (Grade School)", "ASICS", "Kids' Shoes", "Blue / Purple", "#4a56c4", K, 19500,
      R(70, "USD", "official", "https://www.asics.com/us/en-us/gel-noosa-tri-16-grade-school/p/ANA_1014A346-400.html", usd),
      "Grade-school running shoe with a mesh upper and a colourful blue, purple and orange design.", False, True),
]
json.dump({"_note": "Demo catalogue. sellPKR is an ESTIMATED demo price; refPrice is a researched reference (often in another currency), see each note. Photos: see image-sources.json.", "products": L},
          open(base + "products.json", "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(len(L), sorted(set(x["category"] for x in L)))
