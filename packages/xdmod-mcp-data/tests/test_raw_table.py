"""get_raw_data's full table: built from xdmod-data's result, summarized for the model."""

import json

import pandas as pd
import pytest

from xdmod_mcp_data.raw_table import (
    MAX_TABLE_ROWS,
    RawQuery,
    build_table,
    raw_data_result,
)

QUERY = RawQuery(
    realm="Jobs",
    metric="total_cpu_hours",
    dimension="person",
    dataset_type="aggregate",
    aggregation_unit="Auto",
    start_date="2025-01-01",
    end_date="2025-12-31",
    filters={},
)
RETRIEVED = "2026-11-10T12:00:00+00:00"


def aggregate(values, name="CPU Hours: Total", index_name="User"):
    series = pd.Series(
        list(values.values()), index=list(values.keys()), name=name, dtype="Float64"
    )
    series.index.name = index_name
    return series


def timeseries(columns, periods, columns_name="User"):
    frame = pd.DataFrame(columns, index=pd.to_datetime(periods), dtype="Float64")
    frame.index.name = "Time"
    frame.columns.name = columns_name
    return frame


def query(**changes):
    return RawQuery(**{**QUERY.__dict__, **changes})


class TestBuildTable:
    def test_aggregate_is_one_row_per_group_largest_first(self):
        table = build_table(aggregate({"b": 2.0, "a": 5.0, "c": None}), query())
        assert table.columns == [
            {"name": "User", "kind": "label"},
            {"name": "CPU Hours: Total", "kind": "number"},
        ]
        assert table.rows == [["a", 5.0], ["b", 2.0], ["c", None]]

    def test_aggregate_without_a_dimension_is_one_row(self):
        series = pd.Series([12.5], index=["CPU Hours: Total"], dtype="Float64")
        table = build_table(series, query(dimension=None))
        assert table.columns == [
            {"name": "Metric", "kind": "label"},
            {"name": "Value", "kind": "number"},
        ]
        assert table.rows == [["CPU Hours: Total", 12.5]]

    def test_grouped_timeseries_is_one_row_per_period_and_group(self):
        frame = timeseries(
            {"Delta": [1.0, 0.0], "Anvil": [None, 3.0]},
            ["2025-01-01", "2025-02-01"],
            "Resource",
        )
        table = build_table(
            frame,
            query(dataset_type="timeseries", dimension="resource"),
            metric_label="CPU Hours: Total",
        )
        assert table.columns == [
            {"name": "Period", "kind": "period"},
            {"name": "Resource", "kind": "label"},
            {"name": "CPU Hours: Total", "kind": "number"},
        ]
        assert table.rows == [
            ["2025-01-01", "Delta", 1.0],
            ["2025-01-01", "Anvil", None],
            ["2025-02-01", "Delta", 0.0],
            ["2025-02-01", "Anvil", 3.0],
        ]

    def test_grouped_timeseries_falls_back_to_the_metric_id(self):
        frame = timeseries({"Delta": [1.0]}, ["2025-01-01"], "Resource")
        table = build_table(frame, query(dataset_type="timeseries"))
        assert table.columns[2] == {"name": "total_cpu_hours", "kind": "number"}

    def test_timeseries_without_a_dimension_is_one_row_per_period(self):
        frame = timeseries(
            {"CPU Hours: Total": [4.0, 5.5]}, ["2025-01-01", "2025-02-01"], "Metric"
        )
        table = build_table(frame, query(dataset_type="timeseries", dimension=None))
        assert table.columns == [
            {"name": "Period", "kind": "period"},
            {"name": "CPU Hours: Total", "kind": "number"},
        ]
        assert table.rows == [["2025-01-01", 4.0], ["2025-02-01", 5.5]]

    def test_names_stay_text_and_numbers_stay_numbers(self):
        table = build_table(aggregate({'=HYPERLINK("x"), "Doe"\nJ': 1}), query())
        assert table.rows == [['=HYPERLINK("x"), "Doe"\nJ', 1.0]]
        assert isinstance(table.rows[0][1], float)


class TestRawDataResult:
    def test_attaches_every_row_when_asked(self):
        data = aggregate({f"user {i}": float(i) for i in range(500)})
        text, structured = raw_data_result(
            data, query(), attach=True, retrieved=RETRIEVED
        )
        table = structured["table"]
        assert table["version"] == 1
        assert table["row_count"] == 500
        assert len(table["rows"]) == 500
        assert table["source"] == "XDMoD"
        assert table["retrieved"] == RETRIEVED
        assert table["requested"] == {"start": "2025-01-01", "end": "2025-12-31"}
        assert table["realm"] == "Jobs"
        assert table["metric"] == "total_cpu_hours"
        assert table["dimension"] == "person"
        assert table["dataset_type"] == "aggregate"
        assert "the full table, all 500 rows, is attached" in text.lower()
        json.dumps(structured)

    def test_carries_the_filters_it_ran_with(self):
        data = aggregate({"a": 1.0, "b": 2.0})
        _, structured = raw_data_result(
            data,
            query(filters={"resource": ["NCSA DELTA GPU"]}),
            attach=True,
            retrieved=RETRIEVED,
        )
        assert structured["table"]["filters"] == {"resource": ["NCSA DELTA GPU"]}

    def test_the_model_gets_a_summary_not_the_rows(self):
        data = aggregate({f"user {i:05d}": float(i) for i in range(MAX_TABLE_ROWS)})
        text, structured = raw_data_result(
            data, query(), attach=True, retrieved=RETRIEVED
        )
        assert len(structured["table"]["rows"]) == MAX_TABLE_ROWS
        assert "50,000 rows" in text
        assert "Columns: User, CPU Hours: Total" in text
        assert "Sum: 1,249,975,000" in text
        # The first rows, largest first, and no more.
        assert "user 49999" in text
        assert "user 49990" in text
        assert "user 49989" not in text
        assert len(text) < 2500

    def test_long_names_are_cut_in_the_text_but_not_the_table(self):
        name = "x" * 200
        text, structured = raw_data_result(
            aggregate({name: 1.0}), query(), attach=True, retrieved=RETRIEVED
        )
        assert name not in text
        assert structured["table"]["rows"][0][0] == name

    def test_over_the_cap_attaches_nothing_and_asks_to_narrow(self):
        data = aggregate({f"user {i}": 1.0 for i in range(MAX_TABLE_ROWS + 1)})
        text, structured = raw_data_result(
            data, query(), attach=True, retrieved=RETRIEVED
        )
        assert structured is None
        assert "50,001 rows" in text
        assert "more than the 50,000" in text
        assert "narrow" in text.lower()
        assert "attached" not in text.replace("no table is attached", "")

    def test_a_caller_that_did_not_ask_gets_only_the_text(self):
        data = aggregate({f"user {i}": float(i) for i in range(30)})
        text, structured = raw_data_result(
            data, query(), attach=False, retrieved=RETRIEVED
        )
        assert structured is None
        assert "first 10 of 30 rows" in text
        assert "is attached" not in text

    def test_a_small_result_lists_every_row(self):
        text, _ = raw_data_result(
            aggregate({"a": 1.0, "b": 2.0}), query(), attach=True, retrieved=RETRIEVED
        )
        assert "All 2 rows" in text

    def test_averages_are_not_summed(self):
        data = aggregate({"a": 1.0, "b": 3.0}, name="CPU Hours: Per Job")
        text, _ = raw_data_result(
            data, query(metric="avg_cpu_hours"), attach=True, retrieved=RETRIEVED
        )
        assert "Sum" not in text
        assert "Mean: 2" in text

    @pytest.mark.parametrize(
        "metric", ["total_cpu_hours", "job_count", "submitted_job_count"]
    )
    def test_additive_metrics_are_summed(self, metric):
        text, _ = raw_data_result(
            aggregate({"a": 1.0, "b": 3.0}),
            query(metric=metric),
            attach=True,
            retrieved=RETRIEVED,
        )
        assert "Sum: 4" in text

    def test_grouped_timeseries_names_its_largest_groups(self):
        frame = timeseries(
            {"Delta": [1.0, 2.0], "Anvil": [10.0, 20.0], "Expanse": [0.0, 5.0]},
            ["2025-01-01", "2025-02-01"],
            "Resource",
        )
        text, structured = raw_data_result(
            frame,
            query(
                dataset_type="timeseries",
                dimension="resource",
                aggregation_unit="Month",
            ),
            attach=True,
            retrieved=RETRIEVED,
            metric_label="CPU Hours: Total",
        )
        assert structured["table"]["row_count"] == 6
        assert "2 periods x 3 resource values" in text
        assert "Largest totals by Resource: Anvil (30), Expanse (5), Delta (3)" in text
        assert "2025-01-01 to 2025-02-01" in text
