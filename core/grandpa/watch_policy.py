"""Shared validation for arXiv categories and watcher schedules."""
import re


def validate_category(value):
    # arXiv uses both cs.AI and lowercase/hyphenated suffixes: physics.plasm-ph.
    if not isinstance(value, str):
        raise ValueError('arXiv category must be text')
    value = value.strip()
    if len(value) > 80 or not re.fullmatch(r'[a-z][a-z0-9-]*(?:\.[A-Za-z][A-Za-z0-9-]*)?', value):
        raise ValueError('Invalid arXiv category; use a category ID such as physics.plasm-ph or cs.AI')
    return value


def minutes(value, field, *, optional=False):
    if optional and value is None:
        return None
    if isinstance(value, bool):
        raise ValueError(f'{field} must be a positive number of minutes')
    try:
        number = float(value)
    except (ValueError, TypeError):
        raise ValueError(f'{field} must be a positive number of minutes') from None
    if not 1 <= number <= 43200:
        raise ValueError(f'{field} must be between 1 and 43200 minutes')
    return number
