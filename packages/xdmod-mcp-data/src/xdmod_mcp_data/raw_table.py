"""get_raw_data's result as one full table for the user and a short summary for the model.

The table travels as structuredContent, which the ACCESS agent keeps out of the
model's context and the full-screen client shows in its data panel, the way
XDMoD charts travel. The model gets only the summary, so its text stays a few
hundred tokens however large the table is.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Optional, Union

import pandas as pd

# About 2.6 MB of JSON at 52 bytes a row (users by month), measured on
# xdmod.access-ci.org. The table is kept with the conversation, so past this
# the tool asks for a narrower request instead of attaching part of the data.
MAX_TABLE_ROWS = 50_000
SUMMARY_ROWS = 10
# A caller that gets no table (an MCP host) sees what it saw before the table
# could be attached: every aggregate row up to 50, else the top 30, and 50
# rows of a timeseries, about the 10 periods by 4 groups it was shown.
PREVIEW_ALL_AGGREGATE = 50
PREVIEW_AGGREGATE = 30
PREVIEW_TIMESERIES = 50
TOP_GROUPS = 5
MAX_NAME_CHARS = 60

Cell = Union[str, float, None]

# Metrics whose values add up across rows. An average or a count of distinct
# active users summed over periods or groups means nothing.
_ADDITIVE_COUNTS = {"job_count", "started_job_count", "submitted_job_count"}


@dataclass
class RawQuery:
    realm: str
    metric: str
    dimension: Optional[str]
    dataset_type: str
    aggregation_unit: str
    start_date: str
    end_date: str
    filters: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class RawTable:
    columns: list[dict[str, str]]
    rows: list[list[Cell]]
    periods: int = 0
    groups: int = 0


def _number(value: Any) -> Optional[float]:
    if value is None or pd.isna(value):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _period(value: Any) -> str:
    if isinstance(value, pd.Timestamp):
        return str(value.strftime("%Y-%m-%d"))
    return str(value)


def build_table(
    data: Union[pd.Series, pd.DataFrame],
    query: RawQuery,
    metric_label: Optional[str] = None,
) -> RawTable:
    """One row per group (aggregate) or per period and group (timeseries).

    xdmod-data gives an aggregate as a Series indexed by group, and a
    timeseries as a frame indexed by period with a column per group, or a
    single column named for the metric when there is no dimension.
    """
    if isinstance(data, pd.Series):
        if data.index.name is not None:
            value_name = (
                str(data.name)
                if data.name is not None
                else (metric_label or query.metric)
            )
            columns = [
                {"name": str(data.index.name), "kind": "label"},
                {"name": value_name, "kind": "number"},
            ]
        else:
            columns = [
                {"name": "Metric", "kind": "label"},
                {"name": "Value", "kind": "number"},
            ]
        pairs = [(str(k), _number(v)) for k, v in data.items()]
        # Largest first, the way a ranking reads; missing values last.
        pairs.sort(key=lambda p: (p[1] is None, -(p[1] or 0.0)))
        rows: list[list[Cell]] = [[name, value] for name, value in pairs]
        return RawTable(columns, rows, periods=0, groups=len(rows))

    if data.columns.name == "Metric":
        label = (
            str(data.columns[0])
            if len(data.columns)
            else (metric_label or query.metric)
        )
        rows = [[_period(ts), _number(v)] for ts, v in data.iloc[:, 0].items()]
        return RawTable(
            [{"name": "Period", "kind": "period"}, {"name": label, "kind": "number"}],
            rows,
            periods=len(rows),
            groups=1,
        )

    group_name = (
        str(data.columns.name) if data.columns.name else (query.dimension or "Group")
    )
    names = [str(c) for c in data.columns]
    rows = []
    for ts, values in zip(data.index, data.itertuples(index=False, name=None)):
        period = _period(ts)
        rows.extend([period, name, _number(v)] for name, v in zip(names, values))
    return RawTable(
        [
            {"name": "Period", "kind": "period"},
            {"name": group_name, "kind": "label"},
            {"name": metric_label or query.metric, "kind": "number"},
        ],
        rows,
        periods=len(data.index),
        groups=len(names),
    )


def _is_additive(metric: str) -> bool:
    return metric.startswith("total_") or metric in _ADDITIVE_COUNTS


def _fmt(value: Optional[float]) -> str:
    if value is None:
        return "no value"
    return f"{value:,.2f}".rstrip("0").rstrip(".")


def _name(value: Cell) -> str:
    text = str(value)
    return text if len(text) <= MAX_NAME_CHARS else text[: MAX_NAME_CHARS - 1] + "…"


def _cell(value: Cell, kind: str) -> str:
    return _fmt(value) if kind == "number" else _name(value)  # type: ignore[arg-type]


def summary_text(table: RawTable, query: RawQuery, *, attach: bool) -> str:
    count = len(table.rows)
    names = [c["name"] for c in table.columns]
    value_col = len(names) - 1
    lines = [f"**Results:** {count:,} rows."]
    if table.periods and table.groups > 1:
        lines[0] += (
            f" One row per period and {query.dimension}: {table.periods} periods x "
            f"{table.groups:,} {query.dimension} values."
        )
    lines.append(f"Columns: {', '.join(names)}")
    if table.periods and table.rows:
        lines.append(f"Periods: {table.rows[0][0]} to {table.rows[-1][0]}")

    values = [r[value_col] for r in table.rows if r[value_col] is not None]
    numbers = [float(v) for v in values]  # type: ignore[arg-type]
    if numbers:
        stats = []
        if _is_additive(query.metric):
            stats.append(f"Sum: {_fmt(math.fsum(numbers))}")
        stats += [
            f"Mean: {_fmt(math.fsum(numbers) / len(numbers))}",
            f"Min: {_fmt(min(numbers))}",
            f"Max: {_fmt(max(numbers))}",
        ]
        lines.append(f"{names[value_col]} over all rows: " + "; ".join(stats))
        missing = count - len(numbers)
        if missing:
            lines.append(f"{missing:,} rows have no value.")

    if table.periods and table.groups > 1 and _is_additive(query.metric):
        totals: dict[str, float] = {}
        for row in table.rows:
            if row[2] is not None:
                totals[str(row[1])] = totals.get(str(row[1]), 0.0) + float(row[2])  # type: ignore[arg-type]
        top = sorted(totals.items(), key=lambda kv: -kv[1])[:TOP_GROUPS]
        lines.append(
            f"Largest totals by {names[1]}: "
            + ", ".join(f"{_name(k)} ({_fmt(v)})" for k, v in top)
        )

    attached = attach and count <= MAX_TABLE_ROWS
    if attached or count > MAX_TABLE_ROWS:
        limit = SUMMARY_ROWS
    elif table.periods:
        limit = PREVIEW_TIMESERIES
    else:
        limit = count if count <= PREVIEW_ALL_AGGREGATE else PREVIEW_AGGREGATE
    shown = table.rows[:limit]
    heading = (
        f"All {count} rows"
        if count <= limit
        else f"First {len(shown)} of {count:,} rows"
    )
    lines += ["", f"{heading}:", " | ".join(names)]
    kinds = [c["kind"] for c in table.columns]
    lines += [" | ".join(_cell(v, k) for v, k in zip(row, kinds)) for row in shown]
    lines.append("")

    if count > MAX_TABLE_ROWS:
        lines.append(
            f"This result has {count:,} rows, more than the {MAX_TABLE_ROWS:,} a table "
            "can hold, so no table is attached. Ask the user to narrow the request, for example "
            "a shorter date range, a coarser aggregation_unit, a filter, or a dimension with "
            "fewer values, and don't present these rows as the whole result."
        )
    elif attach:
        lines.append(
            f"The full table, all {count:,} rows, is attached for the user, who can see it in "
            "the data panel and download it as CSV. Answer from this summary and point the user "
            "to the table rather than listing its rows."
        )
    elif count > limit:
        lines.append(
            f"Only the first {len(shown)} of {count:,} rows are shown here. Narrow the request "
            "(a filter, a shorter range or a coarser aggregation_unit) to see others."
        )
    return "\n".join(lines) + "\n"


def _filter_names(filters: dict[Any, Any]) -> dict[str, list[str]]:
    """Each filter's values as a list of names. A filter that couldn't be
    checked is passed on as the model gave it, which may be one value, a
    number or a list of them."""
    out: dict[str, list[str]] = {}
    for key, value in filters.items():
        values = value if isinstance(value, (list, tuple)) else [value]
        out[str(key)] = [str(v) for v in values if v is not None]
    return out


def raw_data_result(
    data: Union[pd.Series, pd.DataFrame],
    query: RawQuery,
    *,
    attach: bool,
    retrieved: str,
    metric_label: Optional[str] = None,
) -> tuple[str, Optional[dict[str, Any]]]:
    """The model's summary, and the structuredContent to attach or None."""
    table = build_table(data, query, metric_label)
    text = summary_text(table, query, attach=attach)
    if not attach or len(table.rows) > MAX_TABLE_ROWS:
        return text, None
    return text, {
        "table": {
            "version": 1,
            "source": "XDMoD",
            "realm": query.realm,
            "metric": query.metric,
            "dimension": query.dimension,
            "dataset_type": query.dataset_type,
            "aggregation_unit": query.aggregation_unit,
            "requested": {"start": query.start_date, "end": query.end_date},
            "filters": _filter_names(query.filters),
            "columns": table.columns,
            "rows": table.rows,
            "row_count": len(table.rows),
            "retrieved": retrieved,
        }
    }
