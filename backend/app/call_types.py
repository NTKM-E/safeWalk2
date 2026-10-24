"""Which San Jose police call types count toward route safety, and how much.

Calls for service aren't confirmed crimes; most are traffic stops, alarms and
welfare checks that say nothing about walking safety. We keep only call types a
pedestrian would care about and group them into categories with a weight.
Codes come from the dataset's CALLTYPE_CODE column. "...EMS" (combined event)
variants are folded into their base code by category_for().
"""

# weight: how much one recent call adds to a route's crime score.
CATEGORIES = {
    "violent":  {"label": "Violent",            "weight": 3.0},
    "weapons":  {"label": "Weapons",            "weight": 3.0},
    "disorder": {"label": "Disorder",           "weight": 1.0},
    "property": {"label": "Theft / property",   "weight": 0.5},
}

CALL_TYPE_CATEGORY = {
    # violent: against a person
    "242": "violent",      # BATTERY
    "243D": "violent",     # BATTERY, SERIOUS INJURY
    "240": "violent",      # ASSAULT
    "245": "violent",      # ASSAULT WITH DEADLY WEAPON
    "211": "violent",      # ROBBERY
    "211A": "violent",     # ARMED ROBBERY
    "211SA": "violent",    # STRONG ARM ROBBERY
    "207": "violent",      # KIDNAPPING
    "236": "violent",      # FALSE IMPRISONMENT
    "1071": "violent",     # PERSON SHOT
    "1072": "violent",     # PERSON STABBED
    "415A": "violent",     # DISTURBANCE, FIGHT
    "422": "violent",      # CRIMINAL THREATS
    "422.6": "violent",    # HATE CRIMES
    "646.9": "violent",    # STALKING
    "1067": "violent",     # PERSON CALLING FOR HELP
    "1067X": "violent",    # FEMALE CALLING FOR HELP
    "314": "violent",      # INDECENT EXPOSURE
    "647.6": "violent",    # MOLEST/ANNOY UNDER 18YRS
    # weapons
    "1057": "weapons",     # FIREARMS DISCHARGED
    "246": "weapons",      # SHOOTING INTO OCCP VEH OR DWELLING
    "417": "weapons",      # BRANDISHING A WEAPON
    "415W": "weapons",     # DISTURBANCE, WEAPON
    "1066W": "weapons",    # SUSPICIOUS PERSON W/ WEAPON
    "12020": "weapons",    # ILLEGAL WEAPONS
    "12020G": "weapons",   # ILLEGAL WEAPONS, GANG RELATED
    "12025": "weapons",    # CARRYING A CONCEALED WEAPON
    # disorder: things that make a street feel unsafe to walk
    "415": "disorder",     # DISTURBANCE
    "415UNK": "disorder",  # DISTURBANCE, UNKNOWN
    "1066": "disorder",    # SUSPICIOUS PERSON
    "1066X": "disorder",   # SUSPICIOUS FEMALE
    "1070": "disorder",    # PROWLER
    "647F": "disorder",    # DRUNK IN PUBLIC
    "11300": "disorder",   # NARCOTICS
    "594G": "disorder",    # MALICIOUS MISCHIEF, GANG RELATED
    # property
    "484": "property",     # THEFT
    "487": "property",     # GRAND THEFT
    "488": "property",     # PETTY THEFT
    "459VEH": "property",  # VEHICLE BURGLARY
    "594": "property",     # MALICIOUS MISCHIEF
}


def category_for(code: str | None) -> str | None:
    """Category for a CALLTYPE_CODE, or None if it doesn't matter for walking safety."""
    if not code:
        return None
    code = code.strip().upper()
    if code in CALL_TYPE_CATEGORY:
        return CALL_TYPE_CATEGORY[code]
    if code.endswith("EMS"):
        return CALL_TYPE_CATEGORY.get(code[:-3])
    return None


def all_codes() -> list[str]:
    """Every code to ask the city's API for, including the EMS variants."""
    return sorted({*CALL_TYPE_CATEGORY, *(c + "EMS" for c in CALL_TYPE_CATEGORY)})
