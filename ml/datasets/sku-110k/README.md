# SKU-110K dataset

SKU-110K is a dense shelf product detection dataset (a single "product"
class, with very high object density per image) used to train and evaluate
shelf/product detectors. It is a public academic dataset with its own
license and terms of use.

**BYOND never redistributes SKU-110K.** This repo does not download,
mirror, or commit any SKU-110K file. `ml/datasets/sku-110k/raw/` and
`ml/datasets/sku-110k/processed/` are gitignored.

## Getting the data

Download SKU-110K yourself from its official source, per its license
terms, and place it under `ml/datasets/sku-110k/raw/` in the dataset's
native layout:

```
ml/datasets/sku-110k/raw/
  images/
  annotations/
    annotations_train.csv
    annotations_val.csv
    annotations_test.csv
```

## Preparing the dataset

```bash
python ml/scripts/prepare_sku110k.py --input ml/datasets/sku-110k/raw --output ml/datasets/sku-110k/processed
```

Use `--dry-run` to check the script's plan without requiring anything on
disk (useful for CI and for reviewing the intended output layout before
downloading the real dataset).

CI never requires these files — no test depends on the real SKU-110K
dataset being present.
