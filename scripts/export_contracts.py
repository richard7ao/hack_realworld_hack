"""Export the actual backend models for frontend/adapter integration."""
import json
from pathlib import Path
from backend import models
from pydantic import BaseModel

schemas = {name: cls.model_json_schema() for name, cls in vars(models).items()
           if isinstance(cls, type) and issubclass(cls, BaseModel) and cls not in (BaseModel, models.Model)}
Path("contracts/faultline.schema.json").write_text(json.dumps({"schema_version": "1.0", "models": schemas}, indent=2) + "\n")
print(f"Exported {len(schemas)} canonical models")
