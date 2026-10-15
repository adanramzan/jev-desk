"""Build helpdesk/tickets.json: 34 messages from the Bitext customer-support dataset + 16 hand-written photo/spam tickets.

Usage: python3 scripts/build_tickets.py path/to/Bitext_Sample_Customer_Support_Training_Dataset_27K_responses-v11.csv
Dataset: https://huggingface.co/datasets/bitext/Bitext-customer-support-llm-chatbot-training-dataset (CDLA-Sharing-1.0)
"""
import csv, json, random, re, sys
from pathlib import Path

random.seed(7)
INTENTS = {  # bitext intent -> (our category, subject lines)
    "get_refund": ("refund", ["Refund request", "I want my money back", "Requesting a refund"]),
    "track_refund": ("refund", ["Where is my refund?", "Refund status"]),
    "check_refund_policy": ("refund", ["Question about refunds"]),
    "delivery_period": ("shipping", ["When will my order arrive?", "Delivery time"]),
    "track_order": ("shipping", ["Where is my package?", "Tracking my order"]),
    "delivery_options": ("shipping", ["Shipping options"]),
    "change_shipping_address": ("shipping", ["Wrong delivery address", "Change shipping address"]),
    "payment_issue": ("billing", ["Payment problem", "Card was declined"]),
    "check_invoice": ("billing", ["Question about my invoice", "Invoice"]),
    "get_invoice": ("billing", ["Need an invoice copy"]),
    "check_payment_methods": ("billing", ["Payment methods?"]),
    "recover_password": ("account", ["Can't log in", "Password reset"]),
    "registration_problems": ("account", ["Sign-up not working"]),
    "edit_account": ("account", ["Update my account details"]),
    "delete_account": ("account", ["Close my account", "Delete my account"]),
    "cancel_order": ("order", ["Cancel my order", "Please cancel"]),
    "change_order": ("order", ["Change my order", "Modify order"]),
}
PER_CATEGORY = {"refund": 7, "shipping": 7, "billing": 7, "account": 7, "order": 6}
FILL = {"Order Number": "#48213", "Invoice Number": "INV-20931", "Person Name": "Sam", "Account Type": "Premium",
        "Account Category": "Business", "Refund Amount": "64.90", "Delivery City": "Leeds", "Delivery Country": "UK",
        "Currency Symbol": "$", "Client First Name": "Sam", "Client Last Name": "Ortiz", "Customer Support Phone Number": "",
        "Website URL": "the website", "Online Order Interaction": "order history", "Settings": "settings"}
NAMES = ["Priya Nair", "Tom Becker", "Ana Souza", "Liam O'Connor", "Mei Chen", "Omar Haddad", "Julia Novak", "Kwame Mensah",
         "Sofia Rossi", "Daniel Kim", "Fatima Zahra", "Lucas Martin", "Emma Wilson", "Arjun Mehta", "Noah Fischer",
         "Chloe Dubois", "Yuki Tanaka", "Diego Alvarez", "Hannah Berg", "Ravi Patel"]

HANDWRITTEN = [
    ("damaged", "Mug arrived smashed", "Hi, my order #51234 (the ceramic mug) arrived today completely broken. Photo attached. Can you send a replacement?", ["img/damaged-mug.jpg"], "damaged"),
    ("damaged", "Box crushed on delivery", "The parcel was left on my doorstep like this and the item inside is dented. Really disappointed. See photo.", ["img/damaged-box2.jpg"], "damaged"),
    ("damaged", "Phone screen cracked out of the box", "Just unboxed my new phone and the screen is already cracked!! I haven't even turned it on. Photo attached, I need this sorted today.", ["img/damaged-phone.jpg"], "damaged"),
    ("damaged", "Laptop display broken", "My laptop arrived and the display shows these broken lines from the first boot. Attaching a picture of the screen.", ["img/damaged-laptop.jpg"], "damaged"),
    ("damaged", "Order damaged in transit", "Hello, the mug I ordered as a gift came in pieces, see attached. Order #50988.", ["img/damaged-mug.jpg"], "damaged"),
    ("wrong_item", "This is not what I ordered", "I ordered the brown leather boots in size 42 but received these sneakers instead (photo attached). Order #49120.", ["img/item-sneakers.jpg"], "product"),
    ("wrong_item", "Wrong product sent", "I bought a hiking backpack in grey. The package contained this orange camera bag. Please send the right one.", ["img/item-backpack.jpg"], "product"),
    ("wrong_item", "Received someone else's order?", "I ordered over-ear noise cancelling headphones, but got these small earbuds. See picture.", ["img/item-headphones.jpg"], "product"),
    ("wrong_item", "Got a mug instead of a teapot", "My order was a glass teapot. This mug arrived instead. Attached a photo of what was in the box.", ["img/item-mug.jpg"], "product"),
    ("wrong_item", "Incorrect item in my parcel", "I ordered a plain white t-shirt, size M. The parcel had a striped top and a notebook instead (photo).", ["img/item-tshirt.jpg"], "product"),
    ("billing", "Charged twice", "Hi, I was charged twice for the same order. Here is my receipt showing the payment. Please fix the double charge.", ["img/receipt.jpg"], "receipt"),
    ("billing", "Price on receipt is wrong", "The price on my receipt doesn't match what was advertised. Receipt attached, can you check the charge?", ["img/receipt2.jpg"], "receipt"),
    ("account", "Error when signing in", "Every time I try to sign in I get this error (screenshot attached). I can't access my orders.", ["img/error-signin.png"], "error_screenshot"),
    ("spam", "CONGRATULATIONS you won a $1000 gift card", "Dear winner, claim your $1000 gift card now by clicking this link and entering your bank details. Offer ends today!!!", [], "none"),
    ("spam", "Boost your SEO rankings fast", "Hi, we can get your store to #1 on Google in 7 days. Cheap backlinks, guaranteed results. Reply for our price list.", [], "none"),
    ("spam", "Partnership opportunity crypto", "Invest in our new crypto token and earn 300% in a month. Your customers will love it. Limited spots.", [], "none"),
]


def fill(text):
    return re.sub(r"\{\{([^}]+)\}\}", lambda m: FILL.get(m.group(1).strip(), "my order"), text).strip()


def main(csv_path):
    rows = list(csv.DictReader(open(csv_path, encoding="utf-8")))
    by_cat = {c: [] for c in PER_CATEGORY}
    for i, r in enumerate(rows):
        if r["intent"] in INTENTS and len(r["instruction"]) >= 45:
            by_cat[INTENTS[r["intent"]][0]].append((i, r))
    tickets = []
    for cat, n in PER_CATEGORY.items():
        seen = set()
        for i, r in random.sample(by_cat[cat], len(by_cat[cat])):
            if r["intent"] in seen and len(seen) < len([k for k, v in INTENTS.items() if v[0] == cat]):
                continue  # spread over intents first
            seen.add(r["intent"])
            body = fill(r["instruction"])
            body = body[0].upper() + body[1:]
            tickets.append({"subject": random.choice(INTENTS[r["intent"]][1]), "body": body, "images": [],
                            "truth": {"category": cat, "photo": "none", "source": f"bitext:{i}:{r['intent']}"}})
            if sum(t["truth"]["category"] == cat for t in tickets) == n:
                break
    for cat, subj, body, imgs, photo in HANDWRITTEN:
        tickets.append({"subject": subj, "body": body, "images": imgs, "truth": {"category": cat, "photo": photo, "source": "handwritten"}})
    random.shuffle(tickets)
    for n, t in enumerate(tickets):
        t.update(id=1001 + n, **{"from": random.choice(NAMES)}, received=f"{2 + n * 7 % 230} min ago")
    out = [{k: t[k] for k in ("id", "subject", "from", "received", "body", "images", "truth")} for t in tickets]
    Path("helpdesk/tickets.json").write_text(json.dumps(out, indent=1, ensure_ascii=False))
    print(len(out), {c: sum(t["truth"]["category"] == c for t in out) for c in sorted({t["truth"]["category"] for t in out})})


if __name__ == "__main__":
    main(sys.argv[1])
