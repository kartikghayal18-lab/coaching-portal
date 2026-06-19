# OMR Result Import

Admins can import OScan OMR result exports from the Admin Dashboard under **OMR Results**.

## CSV Import

1. Export the OScan result as CSV or XLSX.
2. Open **Admin Dashboard > OMR Results**.
3. Enter the exact test name.
4. Enter max marks if the CSV does not include a max marks column.
5. Upload the CSV and review the preview.
6. Commit the import.

Supported columns include:

- RollNumber
- Barcode
- Correct Total
- Wrong Total
- Unattempted Total
- Correct Marks Total
- Wrong Marks Total
- Total Marks Total
- Physics Marks
- Chemistry Marks
- Botany Marks
- Zoology Marks
- Rank
- Student Rank

Rows are matched strictly by roll number. If a CSV roll number is not found, that row is added to the import error report and the remaining matched rows can still be committed.

Duplicate rows for the same branch, test, and student are skipped unless **Overwrite duplicate roll numbers for this test** is selected.

## OMR Sheet Uploads

Scanned answer sheets can be uploaded in bulk as PDF, JPG, JPEG, PNG, or a ZIP containing those files.

Name each file with the roll number first:

- `101.pdf`
- `101.jpg`
- `101_mock1.pdf`

Files are stored under:

```text
uploads/omr/<testPaperId>/<rollNumber>.pdf
```

Student and admin access is branch-scoped. Students can only view their own OMR sheets.

## Performance Integration

Imported marks are stored in `test_papers`, so existing performance summaries, reports, graphs, and ranking code continue to read from the same source of truth.
