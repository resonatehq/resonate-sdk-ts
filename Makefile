.PHONY: gen-openapi
gen-openapi: 
	openapi --input ../resonate/api/promises-openapi.yml --output ./lib/core/stores/client --client axios
